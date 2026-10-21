import { Copy, FileUp, ScanLine, SendHorizontal, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import QRCode from 'react-qr-code'
import {
	createPairing,
	forgetPeer,
	joinPairing,
	MAX_TEXT_BYTES,
	pairTicketFrom,
	renameMe,
	testRelay,
} from './engine'
import type { OfferFile } from './envelope'
import { GuestList, untilText } from './invite-sheets'
import { useSettings } from './lib/settings'
import {
	describeLink,
	describeTest,
	LinkDot,
	usePublicRelays,
	useRelayReport,
} from './relay-ui'
import { type ChatItem, isOnline, type Transfer, useApp } from './store'
import {
	acceptOffer,
	cancelOutgoing,
	declineOffer,
	inspectLink,
	receiveFromLink,
	receiveLink,
	sendFiles,
	sendText,
	shareByLink,
} from './transfers'
import {
	copy,
	errorText,
	filesSummary,
	formatBytes,
	Sheet,
	toast,
	useNow,
} from './ui'

const SAME_ORIGIN_RELAY = () => `${window.location.origin}/`

function FileList({ files }: { files: OfferFile[] }) {
	const shown = files.slice(0, 6)
	return (
		<ul className="files">
			{shown.map((f, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed list; names can repeat across folders
				<li key={`${f.name}-${i}`}>
					<span className="file-name">{f.name}</span>
					<span className="file-size">{formatBytes(f.size)}</span>
				</li>
			))}
			{files.length > shown.length && (
				<li>and {files.length - shown.length} more</li>
			)}
		</ul>
	)
}

function Progress({ bytes, total }: { bytes: number; total: number }) {
	const pct = total > 0 ? Math.min(100, (bytes / total) * 100) : 0
	return (
		<>
			<div
				className="progress"
				role="progressbar"
				aria-valuenow={Math.round(pct)}
				aria-valuemin={0}
				aria-valuemax={100}
			>
				<div style={{ width: `${pct}%` }} />
			</div>
			<p className="hint">
				{formatBytes(bytes)} of {formatBytes(total)}
			</p>
		</>
	)
}

function LinkBox({ link }: { link: string }) {
	return (
		<div className="link-box">
			<input
				className="field"
				value={link}
				readOnly
				aria-label="Link"
				onFocus={(e) => e.currentTarget.select()}
			/>
			<button
				type="button"
				className="btn"
				aria-label="Copy link"
				onClick={() => void copy(link)}
			>
				<Copy size={18} />
			</button>
		</div>
	)
}

// ---------------------------------------------------------------- peer

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent)
const SEND_KEYS = IS_MAC ? '⌘ Return' : 'Ctrl + Enter'

function timeLabel(at: number) {
	return new Date(at).toLocaleTimeString([], {
		hour: 'numeric',
		minute: '2-digit',
	})
}

function Thread({ items }: { items: ChatItem[] }) {
	const end = useRef<HTMLDivElement>(null)
	// Keep the newest message in view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the list grows
	useEffect(() => {
		end.current?.scrollIntoView({ block: 'end' })
	}, [items.length])
	if (!items.length) {
		return (
			<p className="thread-empty">
				No messages yet. Messages are end-to-end encrypted and stay only on the
				two devices, until this page closes.
			</p>
		)
	}
	return (
		<div className="thread" role="log" aria-label="Messages">
			{items.map((m) =>
				m.kind === 'files' ? (
					<p key={m.id} className="thread-note">
						{m.body}
					</p>
				) : (
					<div key={m.id} className="bubble" data-dir={m.dir}>
						<pre className="bubble-text">{m.body}</pre>
						<span className="bubble-meta">
							{timeLabel(m.at)}
							<button
								type="button"
								className="bubble-copy"
								aria-label="Copy message"
								onClick={() => void copy(m.body)}
							>
								<Copy size={14} />
							</button>
						</span>
					</div>
				)
			)}
			<div ref={end} />
		</div>
	)
}

/** A paired device: its conversation, plus sending files. */
export function PeerSheet({
	topic,
	onClose,
}: {
	topic: string
	onClose: () => void
}) {
	const peer = useApp((s) => s.peers.find((p) => p.topic === topic))
	const lastSeen = useApp((s) => s.lastSeen)
	const items = useApp((s) => s.chats[topic]) ?? NO_ITEMS
	const now = useNow()
	const [removing, setRemoving] = useState(false)
	const [text, setText] = useState('')
	const [busy, setBusy] = useState(false)
	const fileInput = useRef<HTMLInputElement>(null)

	// While this conversation is on screen, its messages count as read.
	useEffect(() => {
		useApp.getState().set({ openTopic: topic })
		useApp.getState().markRead(topic)
		return () => {
			if (useApp.getState().openTopic === topic)
				useApp.getState().set({ openTopic: null })
		}
	}, [topic])

	if (!peer) return null
	const online = isOnline(lastSeen, topic, now)
	const tooLong = new TextEncoder().encode(text).length > MAX_TEXT_BYTES
	const name = peer.identity.name
	const canSend = Boolean(text.trim()) && !tooLong && !busy

	const pickFiles = async (list: FileList | null) => {
		const files = list ? [...list] : []
		if (!files.length) return
		try {
			await sendFiles(topic, files)
		} catch (error) {
			toast(errorText(error))
		}
	}

	const send = async () => {
		if (!canSend) return
		setBusy(true)
		try {
			await sendText(topic, text)
			setText('')
		} catch (error) {
			toast(errorText(error))
		} finally {
			setBusy(false)
		}
	}

	if (removing) {
		return (
			<Sheet open onClose={onClose} title={`Remove ${name}?`}>
				<p className="hint">
					{name} disappears from this device. To use it again, pair the two
					devices again.
				</p>
				<div className="sheet-actions">
					<button
						type="button"
						className="btn"
						data-variant="danger"
						onClick={() => {
							void forgetPeer(topic)
							onClose()
						}}
					>
						Remove {name}
					</button>
					<button
						type="button"
						className="btn"
						onClick={() => setRemoving(false)}
					>
						Keep it
					</button>
				</div>
			</Sheet>
		)
	}

	return (
		<Sheet open onClose={onClose} title={name} className="sheet-chat">
			<p className="hint">
				{online
					? 'Online now.'
					: 'Offline. Open this page on that device to reach it.'}
			</p>
			<Thread items={items} />
			<div className="composer">
				<textarea
					className="field composer-field"
					aria-label={`Message to ${name}`}
					placeholder={`Message to ${name}`}
					value={text}
					rows={2}
					autoComplete="off"
					spellCheck={false}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
							e.preventDefault()
							void send()
						}
					}}
				/>
				<div className="composer-row">
					<button
						type="button"
						className="btn"
						onClick={() => fileInput.current?.click()}
					>
						<FileUp size={18} /> Send files
					</button>
					<button
						type="button"
						className="btn"
						data-variant="primary"
						disabled={!canSend}
						onClick={() => void send()}
					>
						<SendHorizontal size={18} /> Send
					</button>
				</div>
				<input
					ref={fileInput}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						void pickFiles(e.currentTarget.files)
						e.currentTarget.value = ''
					}}
				/>
			</div>
			{tooLong && (
				<p className="error-text">
					This text is too long. Send it as a file instead.
				</p>
			)}
			<div className="chat-foot">
				<span className="hint keys-hint">{SEND_KEYS} to send</span>
				<button
					type="button"
					className="link-btn"
					onClick={() => setRemoving(true)}
				>
					<Trash2 size={14} /> Remove device
				</button>
			</div>
		</Sheet>
	)
}

const NO_ITEMS: ChatItem[] = []

// ---------------------------------------------------------------- pairing

export function PairSheet({
	onClose,
	onJoined,
	onScan,
}: {
	onClose: () => void
	onJoined: (topic: string) => void
	onScan: () => void
}) {
	const [code, setCode] = useState<{ topic: string; link: string } | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [paste, setPaste] = useState('')
	const [slow, setSlow] = useState(false)
	const peer = useApp((s) =>
		code ? s.peers.find((p) => p.topic === code.topic) : undefined
	)
	const paired = Boolean(peer?.peerId)
	const topicRef = useRef<string | null>(null)

	useEffect(() => {
		let alive = true
		createPairing()
			.then((c) => {
				topicRef.current = c.topic
				if (alive) setCode(c)
			})
			.catch((e) => alive && setError(errorText(e)))
		const timer = setTimeout(() => alive && setSlow(true), 45_000)
		return () => {
			alive = false
			clearTimeout(timer)
			// An unused pairing code is dropped when the sheet closes.
			const topic = topicRef.current
			const p = topic
				? useApp.getState().peers.find((x) => x.topic === topic)
				: undefined
			if (p && !p.peerId) void forgetPeer(p.topic)
		}
	}, [])

	const joinPasted = async () => {
		const ticket = pairTicketFrom(paste)
		if (!ticket) {
			setError('That is not a pairing link.')
			return
		}
		try {
			const topic = await joinPairing(ticket)
			if (topic) onJoined(topic)
			else setError('This is your own pairing code.')
		} catch (e) {
			setError(errorText(e))
		}
	}

	if (paired && peer) {
		return (
			<Sheet open onClose={onClose} title={`Paired with ${peer.identity.name}`}>
				<p className="hint">
					It now appears on your radar whenever this page is open on it.
				</p>
				<div className="sheet-actions">
					<button
						type="button"
						className="btn"
						data-variant="primary"
						onClick={onClose}
					>
						Done
					</button>
				</div>
			</Sheet>
		)
	}

	return (
		<Sheet open onClose={onClose} title="Pair a device">
			<button
				type="button"
				className="btn scan-btn"
				data-variant="primary"
				onClick={onScan}
			>
				<ScanLine size={18} /> Scan the other device's code
			</button>
			<p className="hint">
				Or show this code: on the other device, open Hiroh and tap Scan. Keep
				this page open until it says paired.
			</p>
			{code ? (
				<>
					<div className="qr">
						<QRCode value={code.link} title="Pairing code" />
					</div>
					<LinkBox link={code.link} />
					<p className="hint">
						Show this code only to your own devices or people you trust: anyone
						who opens it before the other device pairs takes its place.
					</p>
				</>
			) : (
				!error && <p className="hint">Making a pairing code…</p>
			)}
			{slow && !paired && (
				<p className="error-text">
					Still waiting. Both devices must use the same connection setting. Open
					Settings on each device and check that they match.
				</p>
			)}
			<label className="label" htmlFor="paste-pair">
				Have a link from the other device?
			</label>
			<div className="link-box">
				<input
					id="paste-pair"
					className="field"
					placeholder="Paste the pairing link"
					value={paste}
					onChange={(e) => setPaste(e.target.value)}
					autoComplete="off"
				/>
				<button
					type="button"
					className="btn"
					disabled={!paste.trim()}
					onClick={() => void joinPasted()}
				>
					Pair
				</button>
			</div>
			{error && <p className="error-text">{error}</p>}
		</Sheet>
	)
}

/** Shown on the device that opened a pairing link, until the pair connects. */
export function JoinPairSheet({
	topic,
	onClose,
}: {
	topic: string
	onClose: () => void
}) {
	const peer = useApp((s) => s.peers.find((p) => p.topic === topic))
	const online = useApp((s) => isOnline(s.lastSeen, topic))
	const [late, setLate] = useState(false)
	useEffect(() => {
		const t = setTimeout(() => setLate(true), 20_000)
		return () => clearTimeout(t)
	}, [])
	if (!peer) return null
	if (online) {
		return (
			<Sheet open onClose={onClose} title={`Paired with ${peer.identity.name}`}>
				<p className="hint">Tap it on the radar to send files or text.</p>
				<div className="sheet-actions">
					<button
						type="button"
						className="btn"
						data-variant="primary"
						onClick={onClose}
					>
						Done
					</button>
				</div>
			</Sheet>
		)
	}
	return (
		<Sheet
			open
			onClose={onClose}
			title={late ? 'Cannot reach the other device' : 'Connecting…'}
		>
			{late ? (
				<>
					<p className="hint">
						Both devices must use the same connection setting. If the other
						device uses a private relay, open Settings here and enter the same
						relay and token. Then open the pairing link again.
					</p>
					<div className="sheet-actions">
						<button
							type="button"
							className="btn"
							data-variant="danger"
							onClick={() => {
								void forgetPeer(topic)
								onClose()
							}}
						>
							Cancel pairing
						</button>
					</div>
				</>
			) : (
				<p className="hint">
					Reaching the device that showed the pairing code.
				</p>
			)}
		</Sheet>
	)
}

/** The pairing code is for another relay: say so and offer Settings. */
export function MismatchSheet({
	text,
	onClose,
	onSettings,
}: {
	text: string
	onClose: () => void
	onSettings: () => void
}) {
	return (
		<Sheet open onClose={onClose} title="These devices cannot meet yet">
			<p className="hint">{text}</p>
			<div className="sheet-actions">
				<button
					type="button"
					className="btn"
					data-variant="primary"
					onClick={onSettings}
				>
					Open Settings
				</button>
				<button type="button" className="btn" onClick={onClose}>
					Close
				</button>
			</div>
		</Sheet>
	)
}

// ---------------------------------------------------------------- links

export function LinkShareSheet({ onClose }: { onClose: () => void }) {
	const [id, setId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const transfer = useApp((s) =>
		id ? s.transfers.find((t) => t.id === id) : undefined
	)
	const fileInput = useRef<HTMLInputElement>(null)

	const close = () => {
		if (id) {
			void cancelOutgoing(id).then(() => useApp.getState().removeTransfer(id))
		}
		onClose()
	}

	const pick = async (list: FileList | null) => {
		const files = list ? [...list] : []
		if (!files.length) return
		try {
			setId(await shareByLink(files))
		} catch (e) {
			setError(errorText(e))
		}
	}

	const link = transfer?.ticket ? receiveLink(transfer.ticket) : null
	return (
		<Sheet open onClose={close} title="Send by link">
			{!id && (
				<>
					<p className="hint">
						For someone who is not on your radar. Anyone with the link can
						download the files while this stays open.
					</p>
					<div className="sheet-actions">
						<button
							type="button"
							className="btn"
							data-variant="primary"
							onClick={() => fileInput.current?.click()}
						>
							<FileUp size={18} /> Choose files
						</button>
					</div>
					<input
						ref={fileInput}
						type="file"
						multiple
						hidden
						onChange={(e) => void pick(e.currentTarget.files)}
					/>
				</>
			)}
			{transfer && !link && transfer.status !== 'failed' && (
				<p className="hint">Preparing {filesSummary(transfer.files)}…</p>
			)}
			{link && transfer && (
				<>
					<p className="hint">{filesSummary(transfer.files)}</p>
					<div className="qr">
						<QRCode value={link} title="Download link" />
					</div>
					<LinkBox link={link} />
					{transfer.status === 'transferring' && (
						<Progress bytes={transfer.bytes} total={transfer.total} />
					)}
					{transfer.status === 'done' && (
						<p className="hint">
							Downloaded. The link keeps working until you stop sharing.
						</p>
					)}
					<div className="sheet-actions">
						<button type="button" className="btn" onClick={close}>
							Stop sharing
						</button>
					</div>
				</>
			)}
			{(error || transfer?.status === 'failed') && (
				<p className="error-text">{error ?? errorText(transfer?.error)}</p>
			)}
		</Sheet>
	)
}

export function ReceiveLinkSheet({
	ticket,
	onClose,
}: {
	ticket: string
	onClose: () => void
}) {
	const [files, setFiles] = useState<OfferFile[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [id, setId] = useState<string | null>(null)
	const transfer = useApp((s) =>
		id ? s.transfers.find((t) => t.id === id) : undefined
	)

	useEffect(() => {
		inspectLink(ticket)
			.then(setFiles)
			.catch((e) =>
				setError(
					`This link does not work any more. The sender may have stopped sharing. (${errorText(e)})`
				)
			)
	}, [ticket])

	const download = async () => {
		if (!files) return
		try {
			setId(await receiveFromLink(ticket, files))
		} catch (e) {
			setError(errorText(e))
		}
	}

	const finish = () => {
		if (id) useApp.getState().removeTransfer(id)
		onClose()
	}

	return (
		<Sheet
			open
			onClose={finish}
			title="Download files"
			dismissible={transfer?.status !== 'transferring'}
		>
			{!files && !error && <p className="hint">Looking up the files…</p>}
			{files && <FileList files={files} />}
			{transfer?.status === 'transferring' && (
				<Progress bytes={transfer.bytes} total={transfer.total} />
			)}
			{transfer?.status === 'done' && (
				<p className="hint">Downloaded. Check your downloads.</p>
			)}
			{(error || transfer?.status === 'failed') && (
				<p className="error-text">{error ?? errorText(transfer?.error)}</p>
			)}
			<div className="sheet-actions">
				{files && !transfer && (
					<button
						type="button"
						className="btn"
						data-variant="primary"
						onClick={() => void download()}
					>
						Download {filesSummary(files)}
					</button>
				)}
				{transfer?.status !== 'transferring' && (
					<button type="button" className="btn" onClick={finish}>
						Close
					</button>
				)}
			</div>
		</Sheet>
	)
}

// ---------------------------------------------------------------- incoming

function OfferSheet({ transfer }: { transfer: Transfer }) {
	const [busy, setBusy] = useState(false)
	const accept = async () => {
		setBusy(true)
		try {
			await acceptOffer(transfer.id)
		} catch (e) {
			toast(errorText(e))
		} finally {
			setBusy(false)
		}
	}
	return (
		<Sheet
			open
			layer="top"
			onClose={() => void declineOffer(transfer.id)}
			title={`${transfer.peerName} wants to send you files`}
		>
			<p className="hint">{filesSummary(transfer.files)}</p>
			<FileList files={transfer.files} />
			<div className="sheet-actions">
				<button
					type="button"
					className="btn"
					data-variant="primary"
					disabled={busy}
					onClick={() => void accept()}
				>
					Accept
				</button>
				<button
					type="button"
					className="btn"
					disabled={busy}
					onClick={() => void declineOffer(transfer.id)}
				>
					Decline
				</button>
			</div>
		</Sheet>
	)
}

const TRANSFER_TITLE: Record<
	Transfer['direction'],
	Partial<Record<Transfer['status'], (name: string) => string>>
> = {
	out: {
		waiting: (n) => `Waiting for ${n} to accept`,
		transferring: (n) => `Sending to ${n}`,
		done: (n) => `Sent to ${n}`,
		declined: (n) => `${n} declined`,
		cancelled: () => 'Send cancelled',
		failed: (n) => `Sending to ${n} failed`,
	},
	in: {
		transferring: (n) => `Receiving from ${n}`,
		done: (n) => `Received from ${n}`,
		cancelled: (n) => `${n} cancelled the send`,
		failed: (n) => `Receiving from ${n} failed`,
	},
}

function TransferSheet({ transfer }: { transfer: Transfer }) {
	const active =
		transfer.status === 'waiting' || transfer.status === 'transferring'
	const title =
		TRANSFER_TITLE[transfer.direction][transfer.status]?.(transfer.peerName) ??
		'Transfer'
	const dismiss = () => useApp.getState().removeTransfer(transfer.id)
	return (
		<Sheet
			open
			layer="top"
			onClose={dismiss}
			title={title}
			dismissible={!active}
		>
			<p className="hint">{filesSummary(transfer.files)}</p>
			{transfer.status === 'transferring' && (
				<Progress bytes={transfer.bytes} total={transfer.total} />
			)}
			{transfer.status === 'done' && transfer.direction === 'in' && (
				<p className="hint">Saved to your downloads.</p>
			)}
			{transfer.status === 'failed' && transfer.error && (
				<p className="error-text">{errorText(transfer.error)}</p>
			)}
			<div className="sheet-actions">
				{active && transfer.direction === 'out' ? (
					<button
						type="button"
						className="btn"
						onClick={() => void cancelOutgoing(transfer.id)}
					>
						Cancel send
					</button>
				) : !active ? (
					<button
						type="button"
						className="btn"
						data-variant="primary"
						onClick={dismiss}
					>
						Done
					</button>
				) : null}
			</div>
		</Sheet>
	)
}

/** One offer or transfer at a time: offers first. Messages go to threads. */
export function IncomingSheets() {
	const transfers = useApp((s) => s.transfers)
	const offer = transfers.find(
		(t) => t.direction === 'in' && t.status === 'asking'
	)
	if (offer) return <OfferSheet transfer={offer} />
	const shown = transfers.find((t) => t.topic && t.status !== 'asking')
	if (shown) return <TransferSheet transfer={shown} />
	return null
}

// ---------------------------------------------------------------- settings

export function SettingsSheet({ onClose }: { onClose: () => void }) {
	const me = useApp((s) => s.me)
	const status = useApp((s) => s.status)
	const engineError = useApp((s) => s.error)
	const settings = useSettings()
	const report = useRelayReport(2000)
	const access = useApp((s) => s.access)
	const guest = useApp((s) => s.guest)
	const publicRelays = usePublicRelays()
	const link = describeLink(report, {
		status,
		error: engineError && errorText(engineError),
	})
	const [name, setName] = useState(me.name)
	const [mode, setMode] = useState<'default' | 'custom'>(
		settings.relayMode === 'custom' ? 'custom' : 'default'
	)
	const [url, setUrl] = useState(settings.relayUrls[0] || SAME_ORIGIN_RELAY())
	const [token, setToken] = useState(settings.relayAuthToken)
	const [test, setTest] = useState<
		{ state: 'running' } | { state: 'done'; ok: boolean; text: string } | null
	>(null)
	const [notify, setNotify] = useState(
		typeof Notification === 'undefined'
			? 'unsupported'
			: Notification.permission
	)
	const urlOk = mode === 'default' || /^https:\/\//.test(url.trim())
	const savedMode = settings.relayMode === 'custom' ? 'custom' : 'default'
	const changed =
		name.trim() !== me.name ||
		mode !== savedMode ||
		(mode === 'custom' &&
			(url.trim() !== (settings.relayUrls[0] ?? '') ||
				token.trim() !== settings.relayAuthToken))

	// A test result belongs to the settings it was run with.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on any edit
	useEffect(() => setTest(null), [mode, url, token])

	const runTest = async () => {
		setTest({ state: 'running' })
		try {
			const result = await testRelay({
				mode,
				url: url.trim(),
				token: token.trim(),
			})
			setTest({ state: 'done', ...describeTest(result) })
		} catch (e) {
			setTest({ state: 'done', ok: false, text: errorText(e) })
		}
	}

	const save = async () => {
		await renameMe(name)
		settings.setRelayAuthToken(
			mode === 'custom' ? token.trim() : settings.relayAuthToken
		)
		settings.setRelayUrls([url.trim()])
		settings.setRelayMode(mode)
		toast('Saved. Reconnecting…')
	}

	return (
		<Sheet open onClose={onClose} title="Settings">
			<span className="label">Connection now</span>
			<p className="link-now" data-state={link.state}>
				<LinkDot state={link.state} />
				<span>{link.text}</span>
			</p>

			<label className="label" htmlFor="me-name">
				Name on other devices
			</label>
			<input
				id="me-name"
				className="field"
				value={name}
				maxLength={40}
				onChange={(e) => setName(e.target.value)}
				autoComplete="off"
			/>

			<span className="label">Relay</span>
			<label className="choice">
				<input
					type="radio"
					name="relay"
					checked={mode === 'custom'}
					onChange={() => setMode('custom')}
				/>
				<span>
					<strong>Private relay</strong>
					<span className="hint">
						Your own relay. Needs its address and an access token.
					</span>
				</span>
			</label>
			{mode === 'custom' && (
				<div className="choice-detail">
					<label className="label" htmlFor="relay-url">
						Relay address
					</label>
					<input
						id="relay-url"
						className="field"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						autoComplete="off"
						inputMode="url"
					/>
					<label className="label" htmlFor="relay-token">
						Access token
					</label>
					<input
						id="relay-token"
						className="field"
						type="password"
						value={token}
						onChange={(e) => setToken(e.target.value)}
						autoComplete="off"
					/>
				</div>
			)}
			<label className="choice">
				<input
					type="radio"
					name="relay"
					checked={mode === 'default'}
					onChange={() => setMode('default')}
				/>
				<span>
					<strong>Public relays</strong>
					<span className="hint">
						No setup. Run by n0, the makers of iroh; they see only encrypted
						data. The nearest one is picked for you:
					</span>
					<span className="relay-list">
						{publicRelays.map((r) => (
							<span key={r.host}>
								{r.place ?? r.host}
								{r.place && <span className="relay-host">{r.host}</span>}
							</span>
						))}
					</span>
				</span>
			</label>
			<p className="hint">
				Two devices can only reach each other when both use the same relay
				setting.
			</p>

			<div className="btn-row" style={{ marginTop: 16 }}>
				<button
					type="button"
					className="btn"
					disabled={!urlOk || test?.state === 'running'}
					onClick={() => void runTest()}
				>
					{test?.state === 'running' ? 'Testing…' : 'Test'}
				</button>
				<button
					type="button"
					className="btn"
					data-variant="primary"
					disabled={!name.trim() || !urlOk || !changed}
					onClick={() => void save()}
				>
					Save
				</button>
			</div>
			{test?.state === 'done' && (
				<p className="test-result" data-ok={test.ok} role="status">
					{test.text}
				</p>
			)}

			{access === 'member' && <GuestList />}
			{guest && guest.until > Date.now() && settings.relayMode === 'custom' && (
				<p className="hint" style={{ marginTop: 14 }}>
					Guest access from {guest.inviter} until {untilText(guest.until)}.
				</p>
			)}

			{notify === 'default' && (
				<button
					type="button"
					className="btn"
					style={{ width: '100%', marginTop: 16 }}
					onClick={async () =>
						setNotify(await Notification.requestPermission())
					}
				>
					Turn on notifications
				</button>
			)}

			<div className="sheet-actions">
				<button type="button" className="btn" onClick={onClose}>
					Close
				</button>
			</div>
		</Sheet>
	)
}
