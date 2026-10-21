import {
	KeyRound,
	Link2,
	QrCode,
	ScanLine,
	Settings,
	UserPlus,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BUILD_LABEL, LICENCES_URL, SOURCE_URL } from './build-info'
import {
	joinPairing,
	pairTicketFrom,
	RelayMismatch,
	startEngine,
	watchRelaySettings,
} from './engine'
import { GuestJoinSheet, InviteSheet } from './invite-sheets'
import { inviteSecretFrom } from './invites'
import { describeLink, LinkDot, useRelayReport } from './relay-ui'
import { ScanSheet } from './scan'
import {
	IncomingSheets,
	JoinPairSheet,
	LinkShareSheet,
	MismatchSheet,
	PairSheet,
	PeerSheet,
	ReceiveLinkSheet,
	SettingsSheet,
} from './sheets'
import { isOnline, type Peer, useApp } from './store'
import { ticketFromReceiveLink, wireTransfers } from './transfers'
import { DeviceIcon, errorText, Toast, toast, useNow } from './ui'

export type OpenSheet =
	| { type: 'peer'; topic: string }
	| { type: 'pair' }
	| { type: 'join'; topic: string }
	| { type: 'link' }
	| { type: 'receive'; ticket: string }
	| { type: 'settings' }
	| { type: 'scan' }
	| { type: 'invite' }
	| { type: 'guest-join'; secret?: string }
	| { type: 'mismatch'; text: string }
	| null

/** Peers sit on the middle and outer rings, spread evenly. */
function peerPosition(index: number, count: number) {
	const ring = count <= 6 ? 31 : index % 2 === 0 ? 31 : 45
	const angle = (index / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2 + 0.35
	return {
		left: `${50 + ring * Math.cos(angle)}%`,
		top: `${50 + ring * Math.sin(angle)}%`,
	}
}

function Radar({
	peers,
	onOpen,
}: {
	peers: Peer[]
	onOpen: (topic: string) => void
}) {
	const lastSeen = useApp((s) => s.lastSeen)
	const unread = useApp((s) => s.unread)
	const me = useApp((s) => s.me)
	const now = useNow()
	const shown = peers.filter((p) => p.peerId)
	return (
		<section className="radar" aria-label="Your devices">
			<div className="radar-field">
				<div className="radar-ring" />
				<div className="radar-ring" />
				<div className="radar-ring" />
				<div className="radar-ripple" />
				<div className="radar-ripple" />
				<div className="radar-ripple" />
				<div className="radar-hub" title={`You: ${me.name}`}>
					<DeviceIcon kind={me.kind} size={30} />
				</div>
				{shown.map((peer, i) => {
					const online = isOnline(lastSeen, peer.topic, now)
					const count = unread[peer.topic] ?? 0
					return (
						<button
							key={peer.topic}
							type="button"
							className="peer"
							data-online={online}
							style={peerPosition(i, shown.length)}
							onClick={() => onOpen(peer.topic)}
							aria-label={
								count
									? `${peer.identity.name}, ${count} new ${count === 1 ? 'message' : 'messages'}`
									: undefined
							}
						>
							<span className="peer-badge">
								<DeviceIcon kind={peer.identity.kind} />
								<span className="peer-dot" />
								{count > 0 && (
									<span className="peer-unread" aria-hidden>
										{count > 9 ? '9+' : count}
									</span>
								)}
							</span>
							<span className="peer-name">{peer.identity.name}</span>
							<span className="peer-state">
								{online ? 'Online' : 'Offline'}
							</span>
						</button>
					)
				})}
				{shown.length === 0 && (
					<p className="radar-empty">
						No devices yet. Pair your phone or another computer once, and it
						appears here whenever this page is open on it.
					</p>
				)}
			</div>
		</section>
	)
}

function RelayLine() {
	const status = useApp((s) => s.status)
	const error = useApp((s) => s.error)
	const report = useRelayReport()
	const link = describeLink(report, {
		status,
		error: error && errorText(error),
	})
	return (
		<span className="me-relay" data-state={link.state}>
			<LinkDot state={link.state} />
			{link.text}
		</span>
	)
}

export function WebApp() {
	const peers = useApp((s) => s.peers)
	const me = useApp((s) => s.me)
	const [sheet, setSheet] = useState<OpenSheet>(null)

	useEffect(() => {
		void startEngine()
		const offRelay = watchRelaySettings()
		const offTransfers = wireTransfers()
		return () => {
			offRelay()
			offTransfers()
		}
	}, [])

	// One way in for a Hiroh link, whether it came from the address bar, a
	// pasted link or the in-app scanner. Returns false if it is not a Hiroh link.
	const openLink = async (href: string): Promise<boolean> => {
		const invite = inviteSecretFrom(href)
		if (invite) {
			setSheet({ type: 'guest-join', secret: invite })
			return true
		}
		const pair = pairTicketFrom(href)
		const ticket = /\/receive\b/.test(href) ? ticketFromReceiveLink(href) : null
		if (!pair && !ticket) return false
		if (ticket) {
			setSheet({ type: 'receive', ticket })
			return true
		}
		try {
			const topic = await joinPairing(pair!)
			if (topic) setSheet({ type: 'join', topic })
			else {
				setSheet(null)
				toast('This is your own pairing code.')
			}
		} catch (error) {
			if (error instanceof RelayMismatch)
				setSheet({ type: 'mismatch', text: error.message })
			else {
				setSheet(null)
				toast(`Pairing failed: ${errorText(error)}`)
			}
		}
		return true
	}
	const openLinkRef = useRef(openLink)
	openLinkRef.current = openLink

	// Links work when opened from a QR code, typed into the address bar, or
	// pasted into an already open tab (a fragment change fires no reload).
	useEffect(() => {
		const handle = () => {
			const href = window.location.href
			if (
				!pairTicketFrom(href) &&
				!inviteSecretFrom(href) &&
				!window.location.pathname.startsWith('/receive')
			)
				return
			window.history.replaceState(null, '', '/')
			void openLinkRef.current(href)
		}
		handle()
		window.addEventListener('hashchange', handle)
		return () => window.removeEventListener('hashchange', handle)
	}, [])

	const onScanned = useCallback((text: string) => {
		void openLinkRef.current(text).then((ok) => {
			if (!ok) {
				setSheet(null)
				toast('That QR code is not a Hiroh code.')
			}
		})
	}, [])

	const close = () => setSheet(null)
	const access = useApp((s) => s.access)

	// A new message opens its conversation, unless something else is open.
	const sheetRef = useRef(sheet)
	sheetRef.current = sheet
	useEffect(
		() =>
			useApp.subscribe((s, prev) => {
				if (s.chats === prev.chats || sheetRef.current) return
				for (const [topic, items] of Object.entries(s.chats)) {
					const last = items[items.length - 1]
					if (
						last?.dir === 'in' &&
						last.kind === 'text' &&
						prev.chats[topic]?.[prev.chats[topic].length - 1] !== last
					) {
						setSheet({ type: 'peer', topic })
						return
					}
				}
			}),
		[]
	)

	return (
		<main className="hiroh">
			<header className="hiroh-header">
				<h1 className="hiroh-title">Hiroh</h1>
				<button
					type="button"
					className="icon-btn"
					aria-label="Scan a code"
					onClick={() => setSheet({ type: 'scan' })}
				>
					<ScanLine size={22} />
				</button>
				<button
					type="button"
					className="icon-btn"
					aria-label="Pair a device"
					onClick={() => setSheet({ type: 'pair' })}
				>
					<QrCode size={22} />
				</button>
				<button
					type="button"
					className="icon-btn"
					aria-label="Settings"
					onClick={() => setSheet({ type: 'settings' })}
				>
					<Settings size={22} />
				</button>
			</header>

			<Radar
				peers={peers}
				onOpen={(topic) => setSheet({ type: 'peer', topic })}
			/>

			<section className="me" aria-label="This device">
				<span className="me-icon">
					<DeviceIcon kind={me.kind} size={22} />
				</span>
				<span className="me-text">
					<span className="me-label">You are known as</span>
					<button
						type="button"
						className="me-name"
						onClick={() => setSheet({ type: 'settings' })}
					>
						{me.name}
					</button>
					<RelayLine />
				</span>
			</section>

			<div className="actions">
				{access === 'member' && (
					<button
						type="button"
						className="btn"
						data-variant="primary"
						onClick={() => setSheet({ type: 'invite' })}
					>
						<UserPlus size={18} /> Invite someone
					</button>
				)}
				{/* Always offered: anyone may have been given a code. */}
				<button
					type="button"
					className={access === 'member' ? 'btn' : 'btn wide'}
					data-variant={access === 'member' ? undefined : 'primary'}
					onClick={() => setSheet({ type: 'guest-join' })}
				>
					<KeyRound size={18} /> Enter invite code
				</button>
				<button
					type="button"
					className="btn"
					onClick={() => setSheet({ type: 'pair' })}
				>
					<QrCode size={18} /> Pair a device
				</button>
				<button
					type="button"
					className="btn"
					onClick={() => setSheet({ type: 'link' })}
				>
					<Link2 size={18} /> Send by link
				</button>
			</div>

			<p className="build">
				{BUILD_LABEL}.{' '}
				<a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
					Source code
				</a>{' '}
				·{' '}
				<a href={LICENCES_URL} target="_blank" rel="noopener noreferrer">
					Licences
				</a>
			</p>

			{sheet?.type === 'peer' && (
				<PeerSheet topic={sheet.topic} onClose={close} />
			)}
			{sheet?.type === 'pair' && (
				<PairSheet
					onClose={close}
					onJoined={(topic) => setSheet({ type: 'join', topic })}
					onScan={() => setSheet({ type: 'scan' })}
				/>
			)}
			{sheet?.type === 'join' && (
				<JoinPairSheet topic={sheet.topic} onClose={close} />
			)}
			{sheet?.type === 'link' && <LinkShareSheet onClose={close} />}
			{sheet?.type === 'receive' && (
				<ReceiveLinkSheet ticket={sheet.ticket} onClose={close} />
			)}
			{sheet?.type === 'settings' && <SettingsSheet onClose={close} />}
			{sheet?.type === 'invite' && <InviteSheet onClose={close} />}
			{sheet?.type === 'guest-join' && (
				<GuestJoinSheet
					secret={sheet.secret}
					onClose={close}
					onJoined={(topic) => setSheet({ type: 'join', topic })}
				/>
			)}
			{sheet?.type === 'scan' && (
				<ScanSheet onClose={close} onCode={onScanned} />
			)}
			{sheet?.type === 'mismatch' && (
				<MismatchSheet
					text={sheet.text}
					onClose={close}
					onSettings={() => setSheet({ type: 'settings' })}
				/>
			)}
			<IncomingSheets />
			<Toast />
		</main>
	)
}
