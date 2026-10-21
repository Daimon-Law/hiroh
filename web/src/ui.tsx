import { Dialog } from '@base-ui/react/dialog'
import { Laptop, Monitor, Smartphone, Tablet, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { DeviceKind } from './identity'
import { hasTransferSheet, useApp } from './store'

/**
 * Bottom sheet on phones, centred card on wider screens. Only one sheet shows
 * at a time: while an offer or transfer is on screen ("top" layer), the sheet
 * under it ("main" layer) hides and keeps its state, then comes back.
 */
export function Sheet({
	open,
	onClose,
	title,
	children,
	dismissible = true,
	layer = 'main',
	className,
}: {
	open: boolean
	onClose: () => void
	title: string
	children: ReactNode
	dismissible?: boolean
	layer?: 'main' | 'top'
	className?: string
}) {
	const covered = useApp(hasTransferSheet) && layer === 'main'
	// Focus the sheet itself on open, not its first field: on a phone, focusing
	// a field pops up the keyboard before the person has read the sheet.
	const popup = useRef<HTMLDivElement>(null)
	// Drag the grip down to close, with a finger or a mouse.
	const drag = useRef<{ id: number; startY: number; dy: number } | null>(null)
	const moveSheet = (dy: number | null) => {
		const el = popup.current
		if (!el) return
		el.style.transition = dy === null ? '' : 'none'
		el.style.transform = dy === null ? '' : `translateY(${dy}px)`
	}
	const onGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!dismissible) return
		drag.current = { id: e.pointerId, startY: e.clientY, dy: 0 }
		e.currentTarget.setPointerCapture(e.pointerId)
	}
	const onGripMove = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = drag.current
		if (!d || d.id !== e.pointerId) return
		d.dy = Math.max(0, e.clientY - d.startY)
		moveSheet(d.dy)
	}
	const onGripUp = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = drag.current
		if (!d || d.id !== e.pointerId) return
		drag.current = null
		const height = popup.current?.offsetHeight ?? 400
		if (d.dy > Math.min(120, height / 4)) {
			moveSheet(height)
			onClose()
		} else {
			moveSheet(null)
		}
	}
	return (
		<Dialog.Root
			open={open && !covered}
			onOpenChange={(next) => {
				if (!next && dismissible) onClose()
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="sheet-backdrop" />
				<Dialog.Popup
					ref={popup}
					initialFocus={popup}
					className={className ? `sheet ${className}` : 'sheet'}
				>
					<div
						className="sheet-grip-area"
						data-draggable={dismissible}
						onPointerDown={onGripDown}
						onPointerMove={onGripMove}
						onPointerUp={onGripUp}
						onPointerCancel={onGripUp}
						aria-hidden
					>
						<div className="sheet-grip" />
					</div>
					<div className="sheet-head">
						<Dialog.Title className="sheet-title">{title}</Dialog.Title>
						{dismissible && (
							<Dialog.Close className="sheet-close" aria-label="Close panel">
								<X size={20} strokeWidth={2.2} aria-hidden />
							</Dialog.Close>
						)}
					</div>
					<div className="sheet-body">{children}</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	)
}

export function DeviceIcon({
	kind,
	size = 26,
}: {
	kind: DeviceKind
	size?: number
}) {
	const Icon = {
		phone: Smartphone,
		tablet: Tablet,
		laptop: Laptop,
		desktop: Monitor,
	}[kind]
	return <Icon size={size} strokeWidth={1.8} aria-hidden />
}

export function formatBytes(n: number) {
	if (n < 1024) return `${n} B`
	const units = ['KB', 'MB', 'GB', 'TB']
	let v = n / 1024
	let i = 0
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024
		i++
	}
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function filesSummary(files: { size: number }[]) {
	const total = files.reduce((n, f) => n + f.size, 0)
	return `${files.length === 1 ? '1 file' : `${files.length} files`}, ${formatBytes(total)}`
}

/** Re-render on an interval, for online/offline state. */
export function useNow(ms = 3000) {
	const [now, setNow] = useState(Date.now())
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), ms)
		return () => clearInterval(id)
	}, [ms])
	return now
}

// ---------------------------------------------------------------- toast

const useToastStore = create<{
	text: string | null
	show: (text: string) => void
}>((set) => {
	let timer: ReturnType<typeof setTimeout> | undefined
	return {
		text: null,
		show: (text) => {
			clearTimeout(timer)
			set({ text })
			timer = setTimeout(() => set({ text: null }), 2800)
		},
	}
})

export const toast = (text: string) => useToastStore.getState().show(text)

export function Toast() {
	const text = useToastStore((s) => s.text)
	return text ? (
		<div className="toast" role="status">
			{text}
		</div>
	) : null
}

export function errorText(error: unknown) {
	const raw = error instanceof Error ? error.message : String(error)
	return raw.replace(/^Error:\s*/, '')
}

export async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text)
		toast('Copied')
	} catch {
		toast('Copy failed. Select the text and copy it.')
	}
}
