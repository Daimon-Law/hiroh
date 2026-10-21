// The relay settings the engine expects, as one JSON-ready object.

import { type RelayFallback, type RelayMode, useSettings } from './settings'

/** Shape read by the engine (`RelayConfigArg` in the engine's protocol crate). */
export type RelayConfig = {
	mode: RelayMode
	urls: string[]
	auth_token: string | null
	fallback: RelayFallback
}

type Input = {
	relayMode: RelayMode
	relayUrls: string[]
	relayAuthToken: string
	relayFallback: RelayFallback
}

export function toRelayConfig({
	relayMode,
	relayUrls,
	relayAuthToken,
	relayFallback,
}: Input): RelayConfig {
	// A browser always needs a relay, so "disabled" means the public relays.
	const mode: RelayMode = relayMode === 'disabled' ? 'default' : relayMode
	const custom = mode === 'custom'
	return {
		mode,
		urls: custom ? relayUrls.map((u) => u.trim()).filter((u) => u !== '') : [],
		// An empty field sends no token; anything else goes to the engine as
		// typed, so a token of only spaces is refused there rather than dropped.
		auth_token: custom && relayAuthToken !== '' ? relayAuthToken : null,
		fallback: relayFallback,
	}
}

/** Relay settings currently saved in this browser. */
export function currentRelayConfig(): RelayConfig {
	return toRelayConfig(useSettings.getState())
}
