// Relay settings, saved in the browser.
//
// The storage key and shape stay the same from build to build, so people keep
// their relay and token when they update.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type RelayMode = 'default' | 'custom' | 'disabled'
export type RelayFallback = 'strict' | 'public'

type RelaySettings = {
	relayMode: RelayMode
	relayUrls: string[]
	relayAuthToken: string
	relayFallback: RelayFallback
}

type Settings = RelaySettings & {
	setRelayMode: (mode: RelayMode) => void
	setRelayUrls: (urls: string[]) => void
	setRelayAuthToken: (token: string) => void
}

const STORAGE_KEY = 'app_settings'
const STORAGE_VERSION = 2

export const useSettings = create<Settings>()(
	persist(
		(set) => ({
			relayMode: 'default',
			relayUrls: [],
			relayAuthToken: '',
			relayFallback: 'strict',
			setRelayMode: (relayMode) => set({ relayMode }),
			setRelayUrls: (relayUrls) => set({ relayUrls }),
			setRelayAuthToken: (relayAuthToken) => set({ relayAuthToken }),
		}),
		{
			name: STORAGE_KEY,
			version: STORAGE_VERSION,
			// Older saves may hold more fields; keep only what Hiroh uses.
			migrate: (saved) => pickRelaySettings(saved),
			merge: (saved, current) => ({ ...current, ...pickRelaySettings(saved) }),
			partialize: ({
				relayMode,
				relayUrls,
				relayAuthToken,
				relayFallback,
			}) => ({
				relayMode,
				relayUrls,
				relayAuthToken,
				relayFallback,
			}),
		}
	)
)

function pickRelaySettings(saved: unknown): Partial<RelaySettings> {
	if (!saved || typeof saved !== 'object') return {}
	const s = saved as Record<string, unknown>
	const out: Partial<RelaySettings> = {}
	if (
		s.relayMode === 'default' ||
		s.relayMode === 'custom' ||
		s.relayMode === 'disabled'
	)
		out.relayMode = s.relayMode
	if (Array.isArray(s.relayUrls))
		out.relayUrls = s.relayUrls.filter(
			(u): u is string => typeof u === 'string'
		)
	if (typeof s.relayAuthToken === 'string')
		out.relayAuthToken = s.relayAuthToken
	if (s.relayFallback === 'strict' || s.relayFallback === 'public')
		out.relayFallback = s.relayFallback
	return out
}
