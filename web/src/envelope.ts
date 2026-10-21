// Application messages carried inside the engine's signed text messages.
// The engine handles transport encryption and signatures; this only gives the
// text a shape so a device can tell a note from a file offer.

export type OfferFile = { name: string; size: number }

export type Envelope =
	| { t: 'text'; body: string }
	/** Sender is serving files under `ticket`; receiver fetches them on accept. */
	| { t: 'offer'; id: string; ticket: string; files: OfferFile[] }
	| { t: 'accepted'; id: string }
	| { t: 'declined'; id: string }
	| { t: 'received'; id: string }
	| { t: 'failed'; id: string; reason: string }

export function encodeEnvelope(envelope: Envelope): string {
	return JSON.stringify(envelope)
}

export function decodeEnvelope(raw: string): Envelope {
	try {
		const v = JSON.parse(raw) as Partial<Envelope> & Record<string, unknown>
		switch (v.t) {
			case 'text':
				if (typeof v.body === 'string') return { t: 'text', body: v.body }
				break
			case 'offer':
				if (
					typeof v.id === 'string' &&
					typeof v.ticket === 'string' &&
					Array.isArray(v.files)
				) {
					const files = (v.files as unknown[])
						.filter(
							(f): f is OfferFile =>
								!!f &&
								typeof (f as OfferFile).name === 'string' &&
								typeof (f as OfferFile).size === 'number'
						)
						.slice(0, 500)
					return { t: 'offer', id: v.id, ticket: v.ticket, files }
				}
				break
			case 'accepted':
			case 'declined':
			case 'received':
				if (typeof v.id === 'string') return { t: v.t, id: v.id }
				break
			case 'failed':
				if (typeof v.id === 'string')
					return { t: 'failed', id: v.id, reason: String(v.reason ?? '') }
				break
		}
	} catch {
		// Plain text from an older build.
	}
	return { t: 'text', body: raw }
}
