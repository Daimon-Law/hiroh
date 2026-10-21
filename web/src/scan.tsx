// Scan a Hiroh QR code with the camera, inside the app, so the pairing runs in
// this browser with its own relay settings. Frames are decoded on the device
// with jsQR; no image leaves the browser.

import jsQR from 'jsqr'
import { useEffect, useRef, useState } from 'react'
import { Sheet } from './ui'

export function ScanSheet({
	onClose,
	onCode,
}: {
	onClose: () => void
	/** Called once with the text of the first QR code found. */
	onCode: (text: string) => void
}) {
	const video = useRef<HTMLVideoElement>(null)
	const [error, setError] = useState<string | null>(null)
	const done = useRef(false)

	useEffect(() => {
		let stream: MediaStream | null = null
		let frame = 0
		let alive = true
		const canvas = document.createElement('canvas')
		const ctx = canvas.getContext('2d', { willReadFrequently: true })

		const tick = () => {
			if (!alive || done.current) return
			const v = video.current
			if (v && ctx && v.readyState >= v.HAVE_ENOUGH_DATA && v.videoWidth) {
				// Decode a scaled-down frame: fast enough on phones, still sharp
				// enough for a code that fills part of the view.
				const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight))
				canvas.width = Math.round(v.videoWidth * scale)
				canvas.height = Math.round(v.videoHeight * scale)
				ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
				const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
				const code = jsQR(image.data, image.width, image.height, {
					inversionAttempts: 'attemptBoth',
				})
				if (code?.data) {
					done.current = true
					onCode(code.data)
					return
				}
			}
			frame = requestAnimationFrame(tick)
		}

		const start = async () => {
			if (!navigator.mediaDevices?.getUserMedia) {
				setError('This browser cannot use the camera here.')
				return
			}
			try {
				stream = await navigator.mediaDevices.getUserMedia({
					video: { facingMode: { ideal: 'environment' } },
					audio: false,
				})
				if (!alive) {
					for (const t of stream.getTracks()) t.stop()
					return
				}
				const v = video.current
				if (v) {
					v.srcObject = stream
					await v.play().catch(() => {})
				}
				frame = requestAnimationFrame(tick)
			} catch (e) {
				const name = e instanceof DOMException ? e.name : ''
				setError(
					name === 'NotAllowedError'
						? 'Camera access is blocked. Allow the camera for this site in your browser settings, then try again.'
						: name === 'NotFoundError'
							? 'No camera found on this device.'
							: `The camera did not start (${name || String(e)}).`
				)
			}
		}
		void start()

		return () => {
			alive = false
			cancelAnimationFrame(frame)
			if (stream) for (const t of stream.getTracks()) t.stop()
		}
	}, [onCode])

	return (
		<Sheet open onClose={onClose} title="Scan a code">
			<p className="hint">
				Point the camera at the QR code on the other device's Hiroh screen.
			</p>
			{error ? (
				<p className="error-text">{error}</p>
			) : (
				<div className="scan-view">
					<video ref={video} muted playsInline aria-label="Camera view" />
					<span className="scan-frame" aria-hidden />
				</div>
			)}
			<div className="sheet-actions">
				<button type="button" className="btn" onClick={onClose}>
					Cancel
				</button>
			</div>
		</Sheet>
	)
}
