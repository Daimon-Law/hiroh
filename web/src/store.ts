import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { OfferFile } from './envelope'
import { detectKind, type PeerIdentity, randomName } from './identity'

/** A device this browser is paired with. One iroh-gossip topic per pair. */
export type Peer = {
	topic: string
	/** Opens the topic: topic id plus the inviting device's address. */
	ticket: string
	/** The other device's iroh endpoint id; null while a pairing code is open. */
	peerId: string | null
	identity: PeerIdentity
	pairedAt: number
}

/** One line in a device's conversation. Kept in memory only. */
export type ChatItem = {
	id: string
	topic: string
	dir: 'in' | 'out'
	/** A text message, or a note that files were sent or received. */
	kind: 'text' | 'files'
	body: string
	at: number
}

export type Transfer = {
	id: string
	direction: 'in' | 'out'
	/** Pair topic, or null for a share link. */
	topic: string | null
	peerName: string
	files: OfferFile[]
	ticket?: string
	status:
		| 'asking'
		| 'waiting'
		| 'transferring'
		| 'done'
		| 'declined'
		| 'failed'
		| 'cancelled'
	bytes: number
	total: number
	error?: string
}

export type EngineStatus = 'off' | 'starting' | 'ready' | 'error'

/** Access granted through an invite, for display. */
export type GuestPass = { until: number; inviter: string }

/** What the access service says about this device. */
export type AccessState = 'unknown' | 'member' | 'refused' | 'no-service'

type Persisted = {
	secretHex: string | null
	/** Key for the file-transfer endpoint; kept so the device stays registered. */
	transferSecretHex: string | null
	guest: GuestPass | null
	me: PeerIdentity
	peers: Peer[]
}

type Live = {
	status: EngineStatus
	error: string | null
	myId: string | null
	/** topic -> time of the last presence announcement from that peer. */
	lastSeen: Record<string, number>
	/** topic -> conversation. Kept in memory only, never written to storage. */
	chats: Record<string, ChatItem[]>
	/** topic -> messages received while that conversation was closed. */
	unread: Record<string, number>
	/** The conversation open on screen, if any. */
	openTopic: string | null
	access: AccessState
	transfers: Transfer[]
}

type Actions = {
	set: (patch: Partial<Persisted & Live>) => void
	upsertPeer: (peer: Peer) => void
	updatePeer: (topic: string, patch: Partial<Peer>) => void
	removePeer: (topic: string) => void
	seen: (topic: string) => void
	pushChat: (item: ChatItem) => void
	markRead: (topic: string) => void
	putTransfer: (transfer: Transfer) => void
	patchTransfer: (id: string, patch: Partial<Transfer>) => void
	removeTransfer: (id: string) => void
}

export type AppState = Persisted & Live & Actions

export const useApp = create<AppState>()(
	persist(
		(set) => ({
			secretHex: null,
			transferSecretHex: null,
			guest: null,
			access: 'unknown',
			me: { name: randomName(), kind: detectKind() },
			peers: [],
			status: 'off',
			error: null,
			myId: null,
			lastSeen: {},
			chats: {},
			unread: {},
			openTopic: null,
			transfers: [],
			set: (patch) => set(patch),
			upsertPeer: (peer) =>
				set((s) => ({
					peers: [...s.peers.filter((p) => p.topic !== peer.topic), peer],
				})),
			updatePeer: (topic, patch) =>
				set((s) => ({
					peers: s.peers.map((p) =>
						p.topic === topic ? { ...p, ...patch } : p
					),
				})),
			removePeer: (topic) =>
				set((s) => {
					const chats = { ...s.chats }
					const unread = { ...s.unread }
					delete chats[topic]
					delete unread[topic]
					return {
						peers: s.peers.filter((p) => p.topic !== topic),
						chats,
						unread,
					}
				}),
			seen: (topic) =>
				set((s) => ({ lastSeen: { ...s.lastSeen, [topic]: Date.now() } })),
			pushChat: (item) =>
				set((s) => ({
					chats: {
						...s.chats,
						[item.topic]: [...(s.chats[item.topic] ?? []), item].slice(-200),
					},
					unread:
						item.dir === 'in' && s.openTopic !== item.topic
							? { ...s.unread, [item.topic]: (s.unread[item.topic] ?? 0) + 1 }
							: s.unread,
				})),
			markRead: (topic) =>
				set((s) => {
					if (!s.unread[topic]) return {}
					const unread = { ...s.unread }
					delete unread[topic]
					return { unread }
				}),
			putTransfer: (transfer) =>
				set((s) => ({
					transfers: [
						...s.transfers.filter((t) => t.id !== transfer.id),
						transfer,
					],
				})),
			patchTransfer: (id, patch) =>
				set((s) => ({
					transfers: s.transfers.map((t) =>
						t.id === id ? { ...t, ...patch } : t
					),
				})),
			removeTransfer: (id) =>
				set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id) })),
		}),
		{
			name: 'app_state',
			version: 1,
			storage: createJSONStorage(() => localStorage),
			partialize: (s): Persisted => ({
				secretHex: s.secretHex,
				transferSecretHex: s.transferSecretHex,
				guest: s.guest,
				me: s.me,
				peers: s.peers,
			}),
		}
	)
)

/** A peer counts as online if it announced itself within this window. */
export const ONLINE_MS = 15_000

export function isOnline(
	lastSeen: Record<string, number>,
	topic: string,
	now = Date.now()
) {
	const t = lastSeen[topic]
	return t !== undefined && now - t < ONLINE_MS
}

/** An offer or a transfer with a paired device takes over the screen. */
export function hasTransferSheet(s: Pick<AppState, 'transfers'>) {
	return s.transfers.some((t) => t.topic !== null)
}
