// Device identity shown to other devices: a random two-word name and the kind
// of device. Names are cosmetic labels, not credentials; the cryptographic
// identity is the iroh endpoint key held by the messaging engine.

export type DeviceKind = 'phone' | 'tablet' | 'laptop' | 'desktop'

export type PeerIdentity = {
	name: string
	kind: DeviceKind
}

const ADJECTIVES = [
	'Dodgy',
	'Smelly',
	'Cheeky',
	'Grumpy',
	'Sleepy',
	'Fluffy',
	'Sneaky',
	'Bouncy',
	'Spiky',
	'Soggy',
	'Chuffed',
	'Rowdy',
	'Lanky',
	'Dusty',
	'Zippy',
	'Wonky',
	'Breezy',
	'Cranky',
	'Jolly',
	'Lazy',
	'Nifty',
	'Plucky',
	'Rusty',
	'Snappy',
	'Thirsty',
	'Toasty',
	'Wobbly',
	'Dizzy',
	'Fancy',
	'Gentle',
	'Humble',
	'Mighty',
]

const ANIMALS = [
	'Dingo',
	'Wombat',
	'Quokka',
	'Koala',
	'Kangaroo',
	'Wallaby',
	'Platypus',
	'Echidna',
	'Emu',
	'Cassowary',
	'Kookaburra',
	'Galah',
	'Cockatoo',
	'Possum',
	'Numbat',
	'Bilby',
	'Bandicoot',
	'Dugong',
	'Lorikeet',
	'Magpie',
	'Cuttlefish',
	'Goanna',
	'Frogmouth',
	'Pademelon',
	'Quoll',
	'Sugar Glider',
	'Ibis',
	'Brolga',
	'Potoroo',
	'Bettong',
	'Wallaroo',
	'Thorny Devil',
]

function pick<T>(list: readonly T[]): T {
	const n = new Uint32Array(1)
	crypto.getRandomValues(n)
	return list[n[0]! % list.length]!
}

export function randomName(): string {
	return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`
}

export function detectKind(): DeviceKind {
	const ua = navigator.userAgent
	if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1))
		return 'tablet'
	if (/Android/.test(ua) && !/Mobile/.test(ua)) return 'tablet'
	if (/iPhone|Android|Mobile/.test(ua)) return 'phone'
	if (/Macintosh|Windows NT|CrOS|Linux/.test(ua))
		return /Macintosh/.test(ua) ? 'laptop' : 'desktop'
	return 'desktop'
}

/** The engine announces one string per device; it carries name and kind. */
export function encodeIdentity(identity: PeerIdentity): string {
	return JSON.stringify({ n: identity.name, k: identity.kind })
}

export function decodeIdentity(raw: string): PeerIdentity {
	try {
		const v = JSON.parse(raw) as { n?: unknown; k?: unknown }
		const kinds: DeviceKind[] = ['phone', 'tablet', 'laptop', 'desktop']
		if (typeof v.n === 'string') {
			return {
				name: v.n.slice(0, 40),
				kind: kinds.includes(v.k as DeviceKind)
					? (v.k as DeviceKind)
					: 'desktop',
			}
		}
	} catch {
		// Older builds announced a plain name.
	}
	return { name: raw.slice(0, 40) || 'Unknown device', kind: 'desktop' }
}
