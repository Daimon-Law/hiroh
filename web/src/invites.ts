// Client for the Hiroh access service invites (deploy/access/server.mjs).
// A member (has a relay token) opens an invite; a guest uses its link or PIN;
// the member allows the guest's device; the guest then pairs with the member.

import { accessApiBase, deviceKeys } from './engine'
import { useSettings } from './lib/settings'
import { useApp } from './store'

const INVITE_KEY = 'invite'

async function call<T>(
	path: string,
	body: unknown,
	base = accessApiBase()
): Promise<T> {
	const res = await fetch(`${base}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	const data = (await res.json().catch(() => ({}))) as { error?: string }
	if (!res.ok)
		throw new Error(data.error || `The server answered ${res.status}.`)
	return data as T
}

const token = () => useSettings.getState().relayAuthToken.trim()

// ---------------------------------------------------------------- members

export type Invite = {
	id: string
	secret: string
	pin: string
	hours: number
	expiresAt: number
}

export type JoinRequest = {
	id: string
	name: string
	kind: string
	match: string
}

export function createInvite(hours: number) {
	const me = useApp.getState().me
	return call<Invite>('invites', { token: token(), hours, name: me.name })
}

export function pollInvite(id: string) {
	return call<{
		status: 'open' | 'expired' | 'gone'
		request: JoinRequest | null
	}>('invites/poll', { token: token(), id })
}

export function decideRequest(
	requestId: string,
	allow: boolean,
	ticket?: string
) {
	return call<{ ok: true }>('invites/decide', {
		token: token(),
		requestId,
		allow,
		ticket,
	})
}

export function cancelInvite(id: string) {
	return call<{ ok: true }>('invites/cancel', { token: token(), id }).catch(
		() => {}
	)
}

export type Guest = {
	name: string
	kind: string
	until: number
	endpoints: string[]
}

export function listGuests() {
	return call<{ guests: Guest[] }>('guests', { token: token() })
}

export function endGuest(endpoints: string[]) {
	return call<{ ok: true }>('guests/revoke', { token: token(), endpoints })
}

export function inviteLink(secret: string) {
	const url = new URL('/', window.location.origin)
	url.hash = new URLSearchParams({ [INVITE_KEY]: secret }).toString()
	return url.toString()
}

export function inviteSecretFrom(href: string): string | null {
	try {
		const url = new URL(href.trim(), window.location.origin)
		return (
			new URLSearchParams(url.hash.slice(1)).get(INVITE_KEY)?.trim() || null
		)
	} catch {
		return null
	}
}

// ---------------------------------------------------------------- guests

/** Guests talk to the access service of the site they opened. */
const siteApi = () => new URL('api/', `${window.location.origin}/`).toString()

export async function askToJoin(code: { secret: string } | { pin: string }) {
	const me = useApp.getState().me
	return call<{
		requestId: string
		match: string
		inviter: string
		expiresAt: number
	}>(
		'join',
		{ ...code, name: me.name, kind: me.kind, endpoints: await deviceKeys() },
		siteApi()
	)
}

export type JoinAnswer =
	| { status: 'pending' | 'denied' | 'expired' | 'gone' }
	| {
			status: 'approved'
			ticket: string
			until: number
			relayUrl: string | null
	  }

export function pollJoin(requestId: string) {
	return call<JoinAnswer>('join/poll', { requestId }, siteApi())
}

/** After approval: use this site's relay, without a token. */
export function becomeGuest(
	answer: Extract<JoinAnswer, { status: 'approved' }>,
	inviter: string
) {
	const settings = useSettings.getState()
	// A device that already has its own token keeps it; it only pairs.
	if (settings.relayMode === 'custom' && settings.relayAuthToken.trim()) return
	settings.setRelayUrls([answer.relayUrl || `${window.location.origin}/`])
	settings.setRelayAuthToken('')
	settings.setRelayMode('custom')
	useApp.getState().set({ guest: { until: answer.until, inviter } })
}
