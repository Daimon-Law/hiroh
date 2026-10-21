// Invite screens. Member side: open an invite, then allow or deny the device
// that uses it. Guest side: enter a PIN (or open a link), show the matching
// code, wait for the member to allow, then pair.

import { useEffect, useRef, useState } from 'react'
import QRCode from 'react-qr-code'
import {
	createPairing,
	forgetPeer,
	joinPairing,
	pairTicketFrom,
} from './engine'
import type { DeviceKind } from './identity'
import {
	askToJoin,
	becomeGuest,
	cancelInvite,
	createInvite,
	decideRequest,
	endGuest,
	type Guest,
	type Invite,
	inviteLink,
	type JoinRequest,
	listGuests,
	pollInvite,
	pollJoin,
} from './invites'
import { useApp } from './store'
import { copy, DeviceIcon, errorText, Sheet, toast } from './ui'

const POLL_MS = 2000

function untilText(until: number) {
	return new Date(until).toLocaleString([], {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: 'numeric',
		minute: '2-digit',
	})
}

function MatchCode({ code }: { code: string }) {
	return (
		<p className="match-code">
			{code.split('').map((d, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed four digits
				<span key={i}>{d}</span>
			))}
		</p>
	)
}

// ---------------------------------------------------------------- member

type InviteStep =
	| { step: 'choose' }
	| { step: 'open'; invite: Invite }
	| { step: 'ask'; invite: Invite; request: JoinRequest }
	| { step: 'pairing'; topic: string; name: string }
	| { step: 'ended'; text: string }

const DURATIONS = [
	{ hours: 24, label: '1 day' },
	{ hours: 168, label: '7 days' },
] as const

export function InviteSheet({ onClose }: { onClose: () => void }) {
	const [state, setState] = useState<InviteStep>({ step: 'choose' })
	const [busy, setBusy] = useState(false)
	const pairingTopic = useRef<string | null>(null)
	const openInvite =
		state.step === 'open' || state.step === 'ask' ? state.invite : null
	const peer = useApp((s) =>
		state.step === 'pairing'
			? s.peers.find((p) => p.topic === state.topic)
			: undefined
	)

	// Watch the open invite for a join request.
	useEffect(() => {
		if (state.step !== 'open') return
		const invite = state.invite
		let alive = true
		const id = setInterval(async () => {
			try {
				const r = await pollInvite(invite.id)
				if (!alive) return
				if (r.request) setState({ step: 'ask', invite, request: r.request })
				else if (r.status !== 'open')
					setState({
						step: 'ended',
						text: 'This invite has expired. Make a new one.',
					})
			} catch {
				// Try again on the next tick.
			}
		}, POLL_MS)
		return () => {
			alive = false
			clearInterval(id)
		}
	}, [state])

	// Closing the sheet ends an unused invite and an unused pairing code.
	const inviteRef = useRef<Invite | null>(null)
	inviteRef.current = openInvite
	useEffect(
		() => () => {
			if (inviteRef.current) void cancelInvite(inviteRef.current.id)
			const topic = pairingTopic.current
			const p = topic
				? useApp.getState().peers.find((x) => x.topic === topic)
				: undefined
			if (p && !p.peerId) void forgetPeer(p.topic)
		},
		[]
	)

	const start = async (hours: number) => {
		setBusy(true)
		try {
			setState({ step: 'open', invite: await createInvite(hours) })
		} catch (e) {
			setState({ step: 'ended', text: errorText(e) })
		} finally {
			setBusy(false)
		}
	}

	const decide = async (allow: boolean) => {
		if (state.step !== 'ask') return
		setBusy(true)
		try {
			if (!allow) {
				await decideRequest(state.request.id, false)
				setState({
					step: 'ended',
					text: `${state.request.name} was not let in.`,
				})
				return
			}
			// A fresh pairing code goes to the guest with the approval.
			const { topic, link } = await createPairing()
			pairingTopic.current = topic
			const ticket = pairTicketFrom(link)
			if (!ticket) throw new Error('Could not make a pairing code.')
			await decideRequest(state.request.id, true, ticket)
			setState({ step: 'pairing', topic, name: state.request.name })
		} catch (e) {
			toast(errorText(e))
		} finally {
			setBusy(false)
		}
	}

	if (state.step === 'pairing') {
		const paired = Boolean(peer?.peerId)
		return (
			<Sheet
				open
				onClose={onClose}
				title={
					paired
						? `Paired with ${peer?.identity.name}`
						: `Letting ${state.name} in…`
				}
			>
				<p className="hint">
					{paired
						? 'You can now chat and send files. Their access ends at the time you chose.'
						: 'Waiting for their device to connect. Keep this open.'}
				</p>
				<div className="sheet-actions">
					<button
						type="button"
						className="btn"
						data-variant="primary"
						onClick={onClose}
					>
						{paired ? 'Done' : 'Close'}
					</button>
				</div>
			</Sheet>
		)
	}

	if (state.step === 'ask') {
		const r = state.request
		return (
			<Sheet
				open
				onClose={() => void decide(false)}
				title={`${r.name} wants to join`}
			>
				<div className="ask-device">
					<DeviceIcon kind={r.kind as DeviceKind} size={30} />
				</div>
				<p className="hint center">
					Their screen shows this code. Allow only if it matches.
				</p>
				<MatchCode code={r.match} />
				<p className="hint center">
					They get access to your relay for{' '}
					{state.invite.hours === 24
						? '1 day'
						: `${state.invite.hours / 24} days`}
					.
				</p>
				<div className="btn-row" style={{ marginTop: 18 }}>
					<button
						type="button"
						className="btn"
						disabled={busy}
						onClick={() => void decide(false)}
					>
						Deny
					</button>
					<button
						type="button"
						className="btn"
						data-variant="primary"
						disabled={busy}
						onClick={() => void decide(true)}
					>
						Allow
					</button>
				</div>
			</Sheet>
		)
	}

	if (state.step === 'open') {
		const link = inviteLink(state.invite.secret)
		const pin = state.invite.pin
		return (
			<Sheet open onClose={onClose} title="Invite someone">
				<p className="hint">
					Send this link, or read out the code. It works once, for 10 minutes.
					You approve the device before it gets in.
				</p>
				<p className="pin">
					{pin.slice(0, 3)} {pin.slice(3)}
				</p>
				<div className="qr">
					<QRCode value={link} title="Invite link" />
				</div>
				<div className="btn-row">
					<button type="button" className="btn" onClick={() => void copy(link)}>
						Copy link
					</button>
					{'share' in navigator && (
						<button
							type="button"
							className="btn"
							data-variant="primary"
							onClick={() =>
								void navigator
									.share({
										title: 'Hiroh invite',
										text: 'Join me on Hiroh',
										url: link,
									})
									.catch(() => {})
							}
						>
							Share
						</button>
					)}
				</div>
				<p className="hint center">Waiting for them…</p>
			</Sheet>
		)
	}

	if (state.step === 'ended') {
		return (
			<Sheet open onClose={onClose} title="Invite">
				<p className="hint">{state.text}</p>
				<div className="sheet-actions">
					<button
						type="button"
						className="btn"
						data-variant="primary"
						onClick={() => setState({ step: 'choose' })}
					>
						New invite
					</button>
					<button type="button" className="btn" onClick={onClose}>
						Close
					</button>
				</div>
			</Sheet>
		)
	}

	return (
		<Sheet open onClose={onClose} title="Invite someone">
			<p className="hint">
				They get in only after you allow their device, for the time you choose.
			</p>
			<span className="label">Access for</span>
			<div className="btn-row">
				{DURATIONS.map((d) => (
					<button
						key={d.hours}
						type="button"
						className="btn"
						data-variant={d.hours === 24 ? 'primary' : undefined}
						disabled={busy}
						onClick={() => void start(d.hours)}
					>
						{d.label}
					</button>
				))}
			</div>
		</Sheet>
	)
}

// ---------------------------------------------------------------- guest

type JoinStep =
	| { step: 'code' }
	| { step: 'waiting'; requestId: string; match: string; inviter: string }
	| { step: 'connecting'; inviter: string }
	| { step: 'ended'; text: string }

export function GuestJoinSheet({
	secret,
	onClose,
	onJoined,
}: {
	/** From an invite link; without it the guest types the PIN. */
	secret?: string
	onClose: () => void
	onJoined: (topic: string) => void
}) {
	const [state, setState] = useState<JoinStep>({ step: 'code' })
	const [pin, setPin] = useState('')
	const [busy, setBusy] = useState(false)
	const started = useRef(false)
	const mounted = useRef(true)
	useEffect(
		() => () => {
			mounted.current = false
		},
		[]
	)

	const ask = async (code: { secret: string } | { pin: string }) => {
		setBusy(true)
		try {
			const r = await askToJoin(code)
			setState({
				step: 'waiting',
				requestId: r.requestId,
				match: r.match,
				inviter: r.inviter,
			})
		} catch (e) {
			setState({ step: 'ended', text: errorText(e) })
		} finally {
			setBusy(false)
		}
	}

	// A link carries the secret: ask at once (once; `ask` is stable enough).
	// biome-ignore lint/correctness/useExhaustiveDependencies: run once per secret
	useEffect(() => {
		if (secret && !started.current) {
			started.current = true
			void ask({ secret })
		}
	}, [secret])

	// Wait for the member's answer.
	useEffect(() => {
		if (state.step !== 'waiting') return
		const { requestId, inviter } = state
		let alive = true
		const id = setInterval(async () => {
			try {
				const r = await pollJoin(requestId)
				if (!alive || r.status === 'pending') return
				if (r.status === 'approved') {
					// Stop polling first; the steps below outlive this effect.
					alive = false
					clearInterval(id)
					setState({ step: 'connecting', inviter })
					becomeGuest(r, inviter)
					try {
						const topic = await joinPairing(r.ticket)
						if (mounted.current && topic) onJoined(topic)
					} catch (e) {
						if (mounted.current) setState({ step: 'ended', text: errorText(e) })
					}
					return
				}
				setState({
					step: 'ended',
					text:
						r.status === 'denied'
							? `${inviter} did not let this device in.`
							: 'No answer in time. Ask for a new invite.',
				})
			} catch (e) {
				if (alive) setState({ step: 'ended', text: errorText(e) })
			}
		}, POLL_MS)
		return () => {
			alive = false
			clearInterval(id)
		}
	}, [state, onJoined])

	if (state.step === 'waiting') {
		return (
			<Sheet open onClose={onClose} title={`Waiting for ${state.inviter}`}>
				<p className="hint center">
					{state.inviter} sees this code on their screen. If they ask, read it
					out.
				</p>
				<MatchCode code={state.match} />
				<p className="hint center">
					They need to tap Allow. Keep this page open.
				</p>
			</Sheet>
		)
	}
	if (state.step === 'connecting') {
		return (
			<Sheet open onClose={onClose} title="Allowed. Connecting…">
				<p className="hint">
					Joining {state.inviter}'s relay and pairing with them.
				</p>
			</Sheet>
		)
	}
	if (state.step === 'ended') {
		return (
			<Sheet open onClose={onClose} title="Invite">
				<p className="error-text">{state.text}</p>
				<div className="sheet-actions">
					{!secret && (
						<button
							type="button"
							className="btn"
							data-variant="primary"
							onClick={() => {
								setPin('')
								setState({ step: 'code' })
							}}
						>
							Try another code
						</button>
					)}
					<button type="button" className="btn" onClick={onClose}>
						Close
					</button>
				</div>
			</Sheet>
		)
	}
	if (secret) {
		return (
			<Sheet open onClose={onClose} title="Opening invite…">
				<p className="hint">Checking the invite.</p>
			</Sheet>
		)
	}
	return (
		<Sheet open onClose={onClose} title="Enter invite code">
			<p className="hint">Type the 6-digit code you were given.</p>
			<input
				className="field pin-field"
				inputMode="numeric"
				autoComplete="one-time-code"
				aria-label="Invite code"
				placeholder="000 000"
				value={pin}
				maxLength={7}
				onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && pin.length === 6) void ask({ pin })
				}}
			/>
			<div className="sheet-actions">
				<button
					type="button"
					className="btn"
					data-variant="primary"
					disabled={pin.length !== 6 || busy}
					onClick={() => void ask({ pin })}
				>
					Continue
				</button>
			</div>
		</Sheet>
	)
}

// ---------------------------------------------------------------- guests list

/** In Settings, for members: guests this token let in, with End access. */
export function GuestList() {
	const [guests, setGuests] = useState<Guest[] | null>(null)
	const load = () =>
		listGuests()
			.then((r) => setGuests(r.guests))
			.catch(() => setGuests([]))
	// biome-ignore lint/correctness/useExhaustiveDependencies: load once on open
	useEffect(() => {
		void load()
	}, [])
	if (!guests?.length) return null
	return (
		<>
			<span className="label">Guests you let in</span>
			<ul className="guest-list">
				{guests.map((g) => (
					<li key={g.endpoints[0]}>
						<span>
							<strong>{g.name}</strong>
							<span className="hint">until {untilText(g.until)}</span>
						</span>
						<button
							type="button"
							className="link-btn"
							onClick={async () => {
								await endGuest(g.endpoints).catch(() => {})
								toast(`${g.name} no longer has access`)
								void load()
							}}
						>
							End access
						</button>
					</li>
				))}
			</ul>
		</>
	)
}

export { untilText }
