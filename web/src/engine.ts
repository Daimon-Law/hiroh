// Messaging engine glue. The engine (hiroh-wasm chat_*) is iroh-gossip with
// iroh QUIC/TLS 1.3 links and Ed25519-signed messages; this file keeps track
// of pairings, presence and routes decoded messages to the app.

import { decodeEnvelope, type Envelope, encodeEnvelope } from './envelope'
import { decodeIdentity, encodeIdentity } from './identity'
import { loadEngine } from './lib/engine-client'
import { currentRelayConfig, toRelayConfig } from './lib/relay-config'
import { useSettings } from './lib/settings'
import { isOnline, useApp } from './store'

type EngineEvent =
	| { type: 'presence'; from: string; nickname: string }
	| { type: 'messageReceived'; from: string; text: string; nickname: string }
	| { type: 'neighborDown'; endpointId: string }
	| { type: string }

type EnvelopeHandler = (topic: string, envelope: Envelope) => void

const PAIR_KEY = 'pair'
/** Leaves room for the signed envelope inside the engine's 64 KiB limit. */
export const MAX_TEXT_BYTES = 60_000
const REDIAL_MS = 30_000

let generation = 0
let startPromise: Promise<void> | null = null
let redialTimer: ReturnType<typeof setInterval> | null = null
let aliveTimer: ReturnType<typeof setInterval> | null = null
/** The access service removes devices silent for 24 hours. An open page
 * tells it, in the background, that it is still in use: on start, then hourly. */
const ALIVE_MS = 60 * 60_000
let unsubscribeAdmission: (() => void) | null = null
let envelopeHandler: EnvelopeHandler = () => {}

export function onEnvelope(handler: EnvelopeHandler) {
	envelopeHandler = handler
}

function nickname() {
	return encodeIdentity(useApp.getState().me)
}

export function pairLink(ticket: string) {
	const url = new URL('/', window.location.origin)
	url.hash = new URLSearchParams({ [PAIR_KEY]: ticket }).toString()
	return url.toString()
}

export function pairTicketFrom(value: string): string | null {
	try {
		const url = new URL(value.trim(), window.location.origin)
		return new URLSearchParams(url.hash.slice(1)).get(PAIR_KEY)?.trim() || null
	} catch {
		return null
	}
}

function onEvent(topic: string, json: string) {
	let event: EngineEvent
	try {
		event = JSON.parse(json) as EngineEvent
	} catch {
		return
	}
	const app = useApp.getState()
	const peer = app.peers.find((p) => p.topic === topic)
	if (!peer) return

	if (event.type === 'presence' && 'from' in event) {
		if (event.from === app.myId) return
		const identity = decodeIdentity(event.nickname)
		if (!peer.peerId) {
			// The first device to join a fresh pairing code becomes the peer.
			app.updatePeer(topic, { peerId: event.from, identity })
		} else if (peer.peerId !== event.from) {
			return
		} else if (
			peer.identity.name !== identity.name ||
			peer.identity.kind !== identity.kind
		) {
			app.updatePeer(topic, { identity })
		}
		app.seen(topic)
		return
	}
	if (event.type === 'messageReceived' && 'text' in event) {
		// The engine verified the signature; accept only the paired device.
		if (!peer.peerId || event.from !== peer.peerId) return
		app.seen(topic)
		envelopeHandler(topic, decodeEnvelope(event.text))
		return
	}
	if (event.type === 'neighborDown' && 'endpointId' in event) {
		if (event.endpointId === peer.peerId) {
			const lastSeen = { ...useApp.getState().lastSeen }
			delete lastSeen[topic]
			useApp.getState().set({ lastSeen })
		}
	}
}

/** Paired devices may connect; anyone may while a pairing code is open. */
async function syncAdmission() {
	const wasm = await loadEngine()
	const { peers } = useApp.getState()
	try {
		wasm.chat_set_allowed(peers.flatMap((p) => (p.peerId ? [p.peerId] : [])))
		wasm.chat_set_pairing_open(peers.some((p) => !p.peerId))
	} catch {
		// Engine not started yet; start() syncs again.
	}
}

async function join(topic: string) {
	const wasm = await loadEngine()
	const peer = useApp.getState().peers.find((p) => p.topic === topic)
	if (!peer) return
	await wasm.chat_join(
		peer.ticket,
		peer.peerId ? [peer.peerId] : [],
		nickname()
	)
}

async function start(gen: number) {
	const app = useApp.getState()
	app.set({ status: 'starting', error: null })
	const wasm = await loadEngine()
	let secretHex = app.secretHex
	if (!secretHex) {
		secretHex = wasm.chat_generate_secret()
		app.set({ secretHex })
	}
	let transferHex = app.transferSecretHex
	if (!transferHex) {
		transferHex = wasm.chat_generate_secret()
		app.set({ transferSecretHex: transferHex })
	}
	wasm.files_set_key(transferHex)
	// With an access service on the relay, register this device's keys first,
	// so the relay lets it in as soon as it connects.
	await registerDevice(wasm, secretHex, transferHex)
	if (gen !== generation) return
	const myId = await wasm.chat_start(
		secretHex,
		JSON.stringify(currentRelayConfig()),
		(topic: string, json: string) => {
			if (gen === generation) onEvent(topic, json)
		}
	)
	if (gen !== generation) return
	// A pairing code left open by a reload or a closed tab is void.
	for (const p of useApp.getState().peers.filter((p) => !p.peerId))
		useApp.getState().removePeer(p.topic)
	useApp.getState().set({ myId, lastSeen: {} })
	unsubscribeAdmission?.()
	unsubscribeAdmission = useApp.subscribe((s, prev) => {
		if (s.peers !== prev.peers) void syncAdmission()
	})
	await syncAdmission()
	for (const peer of useApp.getState().peers) {
		try {
			await join(peer.topic)
		} catch (error) {
			console.error('hiroh: join failed', peer.topic, error)
		}
	}
	useApp.getState().set({ status: 'ready' })
	if (redialTimer) clearInterval(redialTimer)
	redialTimer = setInterval(() => void redial(gen), REDIAL_MS)
	if (aliveTimer) clearInterval(aliveTimer)
	aliveTimer = setInterval(() => void stillHere(), ALIVE_MS)
	void stillHere()
}

/** Base URL of the access service API on the relay host. */
export function accessApiBase(): string {
	const { relayMode, relayUrls } = useSettings.getState()
	const relay = relayMode === 'custom' ? relayUrls[0] : ''
	try {
		return new URL('api/', relay || `${window.location.origin}/`).toString()
	} catch {
		return new URL('api/', `${window.location.origin}/`).toString()
	}
}

/** This device's public keys: messaging and file transfer. */
export async function deviceKeys(): Promise<string[]> {
	const wasm = await loadEngine()
	const app = useApp.getState()
	let secretHex = app.secretHex
	if (!secretHex) {
		secretHex = wasm.chat_generate_secret()
		app.set({ secretHex })
	}
	let transferHex = app.transferSecretHex
	if (!transferHex) {
		transferHex = wasm.chat_generate_secret()
		app.set({ transferSecretHex: transferHex })
	}
	return [wasm.endpoint_id_of(secretHex), wasm.endpoint_id_of(transferHex)]
}

async function registerDevice(
	wasm: Awaited<ReturnType<typeof loadEngine>>,
	secretHex: string,
	transferHex: string
) {
	const { relayMode, relayAuthToken } = useSettings.getState()
	const token = relayAuthToken.trim()
	if (relayMode !== 'custom' || !token) {
		useApp.getState().set({ access: 'unknown' })
		return
	}
	const me = useApp.getState().me
	try {
		const res = await fetch(`${accessApiBase()}register`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				token,
				endpoints: [
					wasm.endpoint_id_of(secretHex),
					wasm.endpoint_id_of(transferHex),
				],
				name: me.name,
				kind: me.kind,
			}),
		})
		useApp.getState().set({
			access: res.ok ? 'member' : res.status === 401 ? 'refused' : 'no-service',
		})
	} catch {
		// No access service (a token-only relay): the relay checks the token.
		useApp.getState().set({ access: 'no-service' })
	}
}

/** Tell the access service this device is in use (private relay only). */
async function stillHere() {
	if (useSettings.getState().relayMode !== 'custom') return
	try {
		await fetch(`${accessApiBase()}seen`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ endpoints: await deviceKeys() }),
		})
	} catch {
		// No access service, or offline: nothing to do.
	}
}

/** Re-dial offline peers, so either device may be the one opened last. */
async function redial(gen: number) {
	if (gen !== generation || document.visibilityState !== 'visible') return
	const { peers, lastSeen } = useApp.getState()
	const wasm = await loadEngine()
	for (const peer of peers) {
		if (!peer.peerId || isOnline(lastSeen, peer.topic)) continue
		try {
			wasm.chat_leave(peer.topic)
			await new Promise((r) => setTimeout(r, 500))
			if (gen !== generation) return
			await join(peer.topic)
		} catch (error) {
			console.error('hiroh: redial failed', peer.topic, error)
		}
	}
}

/** Start the engine, or restart it after a relay settings change. */
export function startEngine(): Promise<void> {
	const gen = ++generation
	startPromise = start(gen).catch((error) => {
		console.error('hiroh: start failed', error)
		if (gen === generation)
			useApp.getState().set({ status: 'error', error: String(error) })
	})
	return startPromise
}

async function ready() {
	if (!startPromise) void startEngine()
	await startPromise
	const { status, error } = useApp.getState()
	if (status !== 'ready')
		throw new Error(error ?? 'The connection is not ready yet.')
}

export function watchRelaySettings(): () => void {
	let last = JSON.stringify(currentRelayConfig())
	return useSettings.subscribe(() => {
		const next = JSON.stringify(currentRelayConfig())
		if (next !== last) {
			last = next
			void startEngine()
		}
	})
}

/** Open a pairing code. Returns the topic and the link to show as a QR code. */
export async function createPairing(): Promise<{
	topic: string
	link: string
}> {
	await ready()
	const wasm = await loadEngine()
	const ticket = await wasm.chat_create(nickname())
	const { topic } = JSON.parse(wasm.chat_ticket_info(ticket)) as {
		topic: string
	}
	useApp.getState().upsertPeer({
		topic,
		ticket,
		peerId: null,
		identity: { name: 'New device', kind: 'desktop' },
		pairedAt: Date.now(),
	})
	return { topic, link: pairLink(ticket) }
}

/** The two devices are set to different relays, so they cannot meet. */
export class RelayMismatch extends Error {}

function hostOf(url: string) {
	try {
		return new URL(url).hostname.replace(/\.$/, '')
	} catch {
		return ''
	}
}

/** n0's public relays (the list iroh ships) all live under this domain. */
const isPublicRelayHost = (host: string) =>
	/\.relay\.n0\.iroh\.link$/.test(host)

/** Why this device cannot reach the device behind a pairing code, or null. */
function relayMismatch(theirRelays: string[]): string | null {
	const theirs = theirRelays.map(hostOf).filter(Boolean)
	if (!theirs.length) return null
	const theirsPublic = theirs.every(isPublicRelayHost)
	const { relayMode, relayUrls } = useSettings.getState()
	if (relayMode !== 'custom') {
		return theirsPublic
			? null
			: `The other device uses the private relay at ${theirs[0]}, and this device uses the public relays. Open Settings here, choose Private relay and enter its address and access token. Then scan or open the code again.`
	}
	const mine = hostOf(relayUrls[0] ?? '')
	if (theirsPublic) {
		return `The other device uses the public relays, and this device uses the private relay at ${mine}. Choose the same relay in Settings on both devices, then make a new code.`
	}
	if (!theirs.includes(mine)) {
		return `The other device uses the relay at ${theirs[0]}, and this device uses ${mine}. Choose the same relay in Settings on both devices.`
	}
	return null
}

/** Join a pairing code. Returns the new peer's topic, or null if not new. */
export async function joinPairing(ticket: string): Promise<string | null> {
	const wasm = await loadEngine()
	const info = JSON.parse(wasm.chat_ticket_info(ticket)) as {
		topic: string
		peers: string[]
		relays?: string[]
	}
	// Checked before waiting for the connection: a wrong relay setting is the
	// usual reason a pairing never connects.
	const mismatch = relayMismatch(info.relays ?? [])
	if (mismatch) throw new RelayMismatch(mismatch)
	await ready()
	const app = useApp.getState()
	if (info.peers.includes(app.myId ?? '')) return null // own code, opened on this device
	if (app.peers.some((p) => p.topic === info.topic)) return info.topic
	app.upsertPeer({
		topic: info.topic,
		ticket,
		peerId: info.peers[0] ?? null,
		identity: { name: 'Connecting…', kind: 'desktop' },
		pairedAt: Date.now(),
	})
	await join(info.topic)
	return info.topic
}

export async function sendEnvelope(topic: string, envelope: Envelope) {
	await ready()
	const text = encodeEnvelope(envelope)
	if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
		throw new Error('This text is too long. Send it as a file instead.')
	}
	const wasm = await loadEngine()
	await wasm.chat_send(topic, text)
}

export async function forgetPeer(topic: string) {
	const wasm = await loadEngine()
	try {
		wasm.chat_leave(topic)
	} catch {
		// Not open.
	}
	useApp.getState().removePeer(topic)
}

export async function renameMe(name: string) {
	const clean = name.trim().slice(0, 40)
	if (!clean) return
	useApp.getState().set({ me: { ...useApp.getState().me, name: clean } })
	if (useApp.getState().status !== 'ready') return
	const wasm = await loadEngine()
	wasm.chat_set_nickname(nickname())
}

// ---------------------------------------------------------------- relay link

/** The link to the relay, as iroh reports it (Endpoint::home_relay_status). */
export type RelayReport = {
	url: string | null
	connected: boolean
	/** The relay refused this device's access token. */
	denied: string | null
	error: string | null
	/** Time to connect, for a test. */
	ms: number | null
}

/** Current link of the running engine, or null while it is not started. */
export async function relayStatus(): Promise<RelayReport | null> {
	if (useApp.getState().status !== 'ready') return null
	const wasm = await loadEngine()
	try {
		return JSON.parse(wasm.chat_relay_status()) as RelayReport
	} catch {
		return null
	}
}

/** Try relay settings before saving them. Never falls back to other relays. */
export async function testRelay(choice: {
	mode: 'default' | 'custom'
	url: string
	token: string
}): Promise<RelayReport> {
	const arg = toRelayConfig({
		relayMode: choice.mode,
		relayUrls: [choice.url],
		relayAuthToken: choice.token,
		relayFallback: 'strict',
	})
	// With an access service, the relay admits only registered device keys,
	// so a test with a throwaway key is always refused. Check the token with
	// the access service instead, then check that the relay answers.
	if (choice.mode === 'custom' && choice.token) {
		const checked = await checkWithAccessService(choice.url, choice.token)
		if (checked) return checked
	}
	const wasm = await loadEngine()
	return JSON.parse(
		await wasm.relay_test(JSON.stringify(arg), 12_000)
	) as RelayReport
}

/** A report from the access service, or null if the relay has none. */
async function checkWithAccessService(
	url: string,
	token: string
): Promise<RelayReport | null> {
	let base: URL
	try {
		base = new URL(url)
	} catch {
		return null
	}
	const start = performance.now()
	let res: Response
	try {
		res = await fetch(new URL('api/token', base), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token }),
		})
	} catch {
		return null
	}
	if (res.status === 404) return null
	const report: RelayReport = {
		url: base.toString(),
		connected: false,
		denied: null,
		error: null,
		ms: null,
	}
	if (res.status === 401) {
		report.denied = 'not authorized'
		return report
	}
	if (!res.ok) {
		report.error = `The relay answered ${res.status}.`
		return report
	}
	try {
		const ping = await fetch(new URL('ping', base), { cache: 'no-store' })
		if (!ping.ok) throw new Error(`The relay answered ${ping.status}.`)
	} catch (e) {
		report.error = e instanceof Error ? e.message : 'The relay did not answer.'
		return report
	}
	report.connected = true
	report.ms = Math.round(performance.now() - start)
	return report
}
