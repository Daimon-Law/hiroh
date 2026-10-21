// Relay link status for the home card and Settings. The state comes from the
// engine (iroh's Endpoint::home_relay_status), polled every few seconds.

import { useEffect, useState } from 'react'
import { type RelayReport, relayStatus } from './engine'
import { loadEngine } from './lib/engine-client'
import { useApp } from './store'

// Region codes in n0's relay host names (AWS style), for a readable place.
const REGION_PLACE: Record<string, string> = {
	use1: 'United States, east',
	use2: 'United States, east',
	usw1: 'United States, west',
	usw2: 'United States, west',
	euc1: 'Europe, Frankfurt',
	euw1: 'Europe, Ireland',
	aps1: 'Asia, Mumbai',
	aps2: 'Asia, Hyderabad',
	apse1: 'Asia, Singapore',
	apse2: 'Australia, Sydney',
}

export type PublicRelay = { host: string; place: string | null }

/** The public relays from the iroh build in use, not a list kept here. */
export function usePublicRelays() {
	const [relays, setRelays] = useState<PublicRelay[]>([])
	useEffect(() => {
		let alive = true
		void loadEngine()
			.then((wasm) => JSON.parse(wasm.public_relays()) as string[])
			.then((urls) => {
				if (!alive) return
				setRelays(
					urls.map((url) => {
						const host = relayHost(url)
						const code = host.split('-')[0] ?? ''
						return { host, place: REGION_PLACE[code] ?? null }
					})
				)
			})
			.catch(() => {})
		return () => {
			alive = false
		}
	}, [])
	return relays
}

export function relayHost(url: string | null | undefined) {
	if (!url) return ''
	try {
		return new URL(url).hostname.replace(/\.$/, '')
	} catch {
		return url
	}
}

/** Live link to the relay. null while the engine is starting or stopped. */
export function useRelayReport(intervalMs = 3000) {
	const status = useApp((s) => s.status)
	const [report, setReport] = useState<RelayReport | null>(null)
	useEffect(() => {
		if (status !== 'ready') {
			setReport(null)
			return
		}
		let alive = true
		const poll = async () => {
			const next = await relayStatus()
			if (alive) setReport(next)
		}
		void poll()
		const id = setInterval(() => void poll(), intervalMs)
		return () => {
			alive = false
			clearInterval(id)
		}
	}, [status, intervalMs])
	return report
}

export type LinkState = 'ok' | 'wait' | 'bad'

/** One short line plus a state, for a status dot. */
export function describeLink(
	report: RelayReport | null,
	engine: { status: string; error: string | null }
): { state: LinkState; text: string } {
	if (engine.status === 'error') {
		return {
			state: 'bad',
			text: `Not connected: ${engine.error ?? 'unknown error'}`,
		}
	}
	if (engine.status !== 'ready' || !report) {
		return { state: 'wait', text: 'Connecting…' }
	}
	if (report.connected) {
		return { state: 'ok', text: `Connected to ${relayHost(report.url)}` }
	}
	if (report.denied) {
		return {
			state: 'bad',
			text: 'The relay refused the access token. Check it in Settings.',
		}
	}
	if (report.error) {
		return {
			state: 'bad',
			text: `Cannot reach ${relayHost(report.url) || 'the relay'}. Trying again.`,
		}
	}
	return { state: 'wait', text: 'Connecting…' }
}

export function LinkDot({ state }: { state: LinkState }) {
	return <span className="link-dot" data-state={state} aria-hidden />
}

/** Result of a Test, as a sentence. */
export function describeTest(report: RelayReport): {
	ok: boolean
	text: string
} {
	if (report.connected) {
		const ms = report.ms === null ? '' : ` in ${report.ms} ms`
		return {
			ok: true,
			text: `Works. Connected to ${relayHost(report.url)}${ms}.`,
		}
	}
	if (report.denied) {
		return {
			ok: false,
			text: `The relay refused this access token (${report.denied}).`,
		}
	}
	return {
		ok: false,
		text: `Could not connect${report.url ? ` to ${relayHost(report.url)}` : ''}. ${report.error ?? ''}`.trim(),
	}
}
