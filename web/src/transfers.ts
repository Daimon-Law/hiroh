// File transfers and texts between devices.
//
// Files move over the engine's iroh-blobs transfer (wasm send_items /
// receive_file). Between paired devices the ticket for a transfer travels
// inside an encrypted, signed message, so nobody copies links around:
//   sender: serve files -> "offer" ; receiver: "accepted" -> fetch -> "received"

import { onEnvelope, sendEnvelope } from './engine'
import type { Envelope, OfferFile } from './envelope'
import {
	listFiles,
	onEngineEvent,
	readProgress,
	receiveFiles,
	saveToDevice,
	shareFiles,
	stopSharing,
} from './lib/engine-client'
import { currentRelayConfig } from './lib/relay-config'
import { type Transfer, useApp } from './store'
import { filesSummary } from './ui'

const RECEIVE_PATH = '/receive'
const TICKET_KEY = 'ticket'

function newId() {
	return crypto.randomUUID()
}

function peerName(topic: string) {
	return (
		useApp.getState().peers.find((p) => p.topic === topic)?.identity.name ??
		'A device'
	)
}

function notify(title: string) {
	if (
		typeof Notification === 'undefined' ||
		Notification.permission !== 'granted'
	)
		return
	if (document.visibilityState === 'visible') return
	try {
		// No body: the content may be a secret and the OS keeps a history.
		new Notification(title, { tag: 'hiroh' })
	} catch {
		// Some mobile browsers only allow notifications from a service worker.
	}
}

/** The engine serves one set of files at a time and fetches one at a time. */
function busyTransfer(direction: 'in' | 'out') {
	return useApp
		.getState()
		.transfers.find(
			(t) =>
				t.direction === direction &&
				(t.status === 'waiting' || t.status === 'transferring')
		)
}

async function serve(files: File[]): Promise<string> {
	const names = files.map((f) => f.name)
	const bytes = await Promise.all(
		files.map(async (f) => new Uint8Array(await f.arrayBuffer()))
	)
	return shareFiles(names, bytes, currentRelayConfig())
}

async function stopServing() {
	try {
		await stopSharing()
	} catch {
		// Nothing being served.
	}
}

// ---------------------------------------------------------------- sending

export async function sendFiles(topic: string, files: File[]) {
	if (!files.length) return
	if (busyTransfer('out'))
		throw new Error('Wait for the current send to finish.')
	const app = useApp.getState()
	const id = newId()
	const offerFiles: OfferFile[] = files.map((f) => ({
		name: f.name,
		size: f.size,
	}))
	const total = offerFiles.reduce((n, f) => n + f.size, 0)
	app.putTransfer({
		id,
		direction: 'out',
		topic,
		peerName: peerName(topic),
		files: offerFiles,
		status: 'waiting',
		bytes: 0,
		total,
	})
	try {
		const ticket = await serve(files)
		app.patchTransfer(id, { ticket })
		await sendEnvelope(topic, { t: 'offer', id, ticket, files: offerFiles })
	} catch (error) {
		await stopServing()
		app.patchTransfer(id, { status: 'failed', error: String(error) })
	}
}

/** Serve files under a link anyone can open (no pairing). */
export async function shareByLink(files: File[]): Promise<string> {
	if (busyTransfer('out'))
		throw new Error('Wait for the current send to finish.')
	const app = useApp.getState()
	const id = newId()
	const offerFiles = files.map((f) => ({ name: f.name, size: f.size }))
	const total = offerFiles.reduce((n, f) => n + f.size, 0)
	app.putTransfer({
		id,
		direction: 'out',
		topic: null,
		peerName: 'Anyone with the link',
		files: offerFiles,
		status: 'waiting',
		bytes: 0,
		total,
	})
	try {
		const ticket = await serve(files)
		app.patchTransfer(id, { ticket })
		return id
	} catch (error) {
		app.patchTransfer(id, { status: 'failed', error: String(error) })
		throw error
	}
}

export function receiveLink(ticket: string) {
	const url = new URL(RECEIVE_PATH, window.location.origin)
	// In the fragment, which browsers never send to the server.
	url.hash = new URLSearchParams({ [TICKET_KEY]: ticket }).toString()
	return url.toString()
}

export function ticketFromReceiveLink(value: string): string | null {
	try {
		const url = new URL(value.trim(), window.location.origin)
		return (
			new URLSearchParams(url.hash.slice(1)).get(TICKET_KEY)?.trim() ||
			url.searchParams.get(TICKET_KEY)?.trim() ||
			null
		)
	} catch {
		return null
	}
}

export async function cancelOutgoing(id: string) {
	const t = useApp.getState().transfers.find((x) => x.id === id)
	if (!t) return
	await stopServing()
	useApp.getState().patchTransfer(id, { status: 'cancelled' })
	if (t.topic)
		await sendEnvelope(t.topic, { t: 'failed', id, reason: 'cancelled' }).catch(
			() => {}
		)
}

// ---------------------------------------------------------------- receiving

async function fetchFiles(id: string, ticket: string) {
	const app = useApp.getState()
	app.patchTransfer(id, { status: 'transferring' })
	const { fileNames, bytesList } = await receiveFiles(
		ticket,
		currentRelayConfig()
	)
	fileNames.forEach((name, i) => {
		saveToDevice(bytesList[i]!, name.split('/').pop() || name)
	})
	const total = bytesList.reduce((n, b) => n + b.length, 0)
	app.patchTransfer(id, { status: 'done', bytes: total, total })
}

export async function acceptOffer(id: string) {
	const t = useApp.getState().transfers.find((x) => x.id === id)
	if (!t?.ticket || !t.topic) return
	if (busyTransfer('in'))
		throw new Error('Wait for the current download to finish.')
	await sendEnvelope(t.topic, { t: 'accepted', id })
	try {
		await fetchFiles(id, t.ticket)
		await sendEnvelope(t.topic, { t: 'received', id }).catch(() => {})
	} catch (error) {
		useApp
			.getState()
			.patchTransfer(id, { status: 'failed', error: String(error) })
		await sendEnvelope(t.topic, {
			t: 'failed',
			id,
			reason: String(error),
		}).catch(() => {})
	}
}

export async function declineOffer(id: string) {
	const t = useApp.getState().transfers.find((x) => x.id === id)
	useApp.getState().removeTransfer(id)
	if (t?.topic)
		await sendEnvelope(t.topic, { t: 'declined', id }).catch(() => {})
}

/** Look at a share link: what files are behind it. */
export async function inspectLink(ticket: string): Promise<OfferFile[]> {
	return (await listFiles(ticket)).map((f) => ({ name: f.name, size: f.size }))
}

export async function receiveFromLink(ticket: string, files: OfferFile[]) {
	if (busyTransfer('in'))
		throw new Error('Wait for the current download to finish.')
	const id = newId()
	const total = files.reduce((n, f) => n + f.size, 0)
	useApp.getState().putTransfer({
		id,
		direction: 'in',
		topic: null,
		peerName: 'Shared link',
		files,
		ticket,
		status: 'transferring',
		bytes: 0,
		total,
	})
	try {
		await fetchFiles(id, ticket)
	} catch (error) {
		useApp
			.getState()
			.patchTransfer(id, { status: 'failed', error: String(error) })
	}
	return id
}

// ---------------------------------------------------------------- texts

export async function sendText(topic: string, body: string) {
	await sendEnvelope(topic, { t: 'text', body })
	useApp.getState().pushChat({
		id: newId(),
		topic,
		dir: 'out',
		kind: 'text',
		body,
		at: Date.now(),
	})
}

// ---------------------------------------------------------------- wiring

function handleEnvelope(topic: string, env: Envelope) {
	const app = useApp.getState()
	const from = peerName(topic)
	switch (env.t) {
		case 'text':
			app.pushChat({
				id: newId(),
				topic,
				dir: 'in',
				kind: 'text',
				body: env.body,
				at: Date.now(),
			})
			notify(`Message from ${from}`)
			return
		case 'offer': {
			const total = env.files.reduce((n, f) => n + f.size, 0)
			app.putTransfer({
				id: env.id,
				direction: 'in',
				topic,
				peerName: from,
				files: env.files,
				ticket: env.ticket,
				status: 'asking',
				bytes: 0,
				total,
			})
			notify(`${from} wants to send you files`)
			return
		}
		case 'accepted':
			app.patchTransfer(env.id, { status: 'transferring' })
			return
		case 'received': {
			const t = app.transfers.find((x) => x.id === env.id)
			app.patchTransfer(env.id, { status: 'done', bytes: t?.total ?? 0 })
			void stopServing()
			return
		}
		case 'declined': {
			const t = app.transfers.find((x) => x.id === env.id)
			if (t?.direction === 'out') {
				app.patchTransfer(env.id, { status: 'declined' })
				void stopServing()
			}
			return
		}
		case 'failed': {
			const t = app.transfers.find((x) => x.id === env.id)
			if (!t) return
			app.patchTransfer(env.id, {
				status: env.reason === 'cancelled' ? 'cancelled' : 'failed',
				error: env.reason,
			})
			if (t.direction === 'out') void stopServing()
		}
	}
}

function trackProgress(event: string, direction: 'in' | 'out') {
	return onEngineEvent(event, (payload) => {
		if (typeof payload !== 'string') return
		const p = readProgress(payload)
		if (!p) return
		const t = useApp
			.getState()
			.transfers.find(
				(x) => x.direction === direction && x.status === 'transferring'
			)
		if (t)
			useApp.getState().patchTransfer(t.id, {
				bytes: p.done,
				total: p.total || t.total,
			})
	})
}

function fileNames(files: OfferFile[]) {
	const names = files.slice(0, 3).map((f) => f.name)
	if (files.length > 3) names.push(`and ${files.length - 3} more`)
	return names.join(', ')
}

/** Note finished file transfers in the conversation with that device. */
function logFinishedTransfers() {
	return useApp.subscribe((s, prev) => {
		if (s.transfers === prev.transfers) return
		for (const t of s.transfers) {
			if (!t.topic || t.status !== 'done') continue
			if (prev.transfers.find((p) => p.id === t.id)?.status === 'done') continue
			const verb = t.direction === 'out' ? 'Sent' : 'Received'
			s.pushChat({
				id: `files-${t.id}`,
				topic: t.topic,
				dir: t.direction,
				kind: 'files',
				body: `${verb} ${filesSummary(t.files)}: ${fileNames(t.files)}`,
				at: Date.now(),
			})
		}
	})
}

export function wireTransfers(): () => void {
	onEnvelope(handleEnvelope)
	const offs = [
		logFinishedTransfers(),
		trackProgress('send-progress', 'out'),
		trackProgress('receive-progress', 'in'),
	]
	// A link share has no peer to report back; mark it transferring on first progress.
	offs.push(
		onEngineEvent('send-started', () => {
			const t = useApp
				.getState()
				.transfers.find(
					(x) => x.direction === 'out' && x.status === 'waiting' && !x.topic
				)
			if (t) useApp.getState().patchTransfer(t.id, { status: 'transferring' })
		})
	)
	offs.push(
		onEngineEvent('send-done', () => {
			const t = useApp
				.getState()
				.transfers.find(
					(x) =>
						x.direction === 'out' && x.status === 'transferring' && !x.topic
				)
			if (t)
				useApp
					.getState()
					.patchTransfer(t.id, { status: 'done', bytes: t.total })
		})
	)
	return () => {
		for (const off of offs) off()
	}
}

export function transferById(id: string): Transfer | undefined {
	return useApp.getState().transfers.find((t) => t.id === id)
}
