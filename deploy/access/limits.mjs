// Client addresses and failure limits for the Hiroh access service.
// No third-party packages.

import { BlockList, isIP } from 'node:net'

// ------------------------------------------------------------ addresses

/** Proxy addresses trusted by default: loopback, private, CGNAT/Tailscale,
 * link-local and IPv6 unique-local. Same idea as Caddy's private_ranges. */
export const DEFAULT_TRUSTED_PROXIES = [
	'127.0.0.0/8',
	'10.0.0.0/8',
	'172.16.0.0/12',
	'192.168.0.0/16',
	'100.64.0.0/10',
	'169.254.0.0/16',
	'::1/128',
	'fc00::/7',
	'fe80::/10',
]

/** "::ffff:1.2.3.4" -> "1.2.3.4"; anything that is not an IP -> null. */
export function normalizeIp(value) {
	if (typeof value !== 'string') return null
	let ip = value.trim()
	if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
	if (mapped) ip = mapped[1]
	return isIP(ip) ? ip.toLowerCase() : null
}

/** A test for "is this address one of my proxies", from CIDR strings. */
export function trustTest(cidrs) {
	const list = new BlockList()
	for (const raw of cidrs) {
		const [net, bits] = raw.trim().split('/')
		const type = isIP(net) === 6 ? 'ipv6' : isIP(net) === 4 ? 'ipv4' : null
		if (!type) throw new Error(`not an IP range: '${raw}'`)
		const prefix = bits === undefined ? (type === 'ipv4' ? 32 : 128) : Number(bits)
		list.addSubnet(net, prefix, type)
	}
	return (ip) => {
		const n = normalizeIp(ip)
		return n !== null && list.check(n, isIP(n) === 6 ? 'ipv6' : 'ipv4')
	}
}

/** Parses a comma-separated list of header names: trimmed, lower case. */
export function headerList(value) {
	return String(value ?? '')
		.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean)
}

/**
 * The visitor's address.
 *
 * - With no headers configured, or when the TCP peer is not a trusted proxy,
 *   the TCP peer address is the answer. Headers from anyone else are ignored.
 * - A single-value header (such as cf-connecting-ip) is used when it holds a
 *   valid IP.
 * - X-Forwarded-For is read from the right: each proxy appends the address it
 *   saw, so the rightmost entry that is not a trusted proxy is the visitor.
 *   Entries further left were sent by the client and can be forged. If every
 *   entry is a trusted proxy (a LAN visitor), the leftmost is used.
 */
export function clientAddress(req, headers, isTrusted) {
	const peer = normalizeIp(req.socket?.remoteAddress) ?? 'unknown'
	if (!headers.length || !isTrusted(peer)) return peer
	for (const name of headers) {
		const raw = req.headers[name]
		if (raw === undefined) continue
		const value = Array.isArray(raw) ? raw.join(',') : String(raw)
		if (name === 'x-forwarded-for') {
			const ip = fromForwardedFor(value, isTrusted)
			if (ip) return ip
		} else {
			const ip = normalizeIp(value)
			if (ip) return ip
		}
	}
	return peer
}

function fromForwardedFor(value, isTrusted) {
	const entries = value.split(',')
	let leftmost = null
	for (let i = entries.length - 1; i >= 0; i--) {
		const ip = normalizeIp(entries[i])
		if (!ip) break // a malformed entry: trust nothing to its left
		if (!isTrusted(ip)) return ip
		leftmost = ip
	}
	return leftmost
}

/** The limiter key for an address. IPv6 is grouped by /64, because one
 * subscriber usually holds a whole /64 and could rotate through it. */
export function limitKey(ip) {
	if (isIP(ip) !== 6) return ip
	const [head, tail = ''] = ip.split('::')
	const left = head ? head.split(':') : []
	const right = tail ? tail.split(':') : []
	const groups = ip.includes('::')
		? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
		: left
	return `${groups
		.slice(0, 4)
		.map((g) => Number.parseInt(g || '0', 16).toString(16))
		.join(':')}::/64`
}

// ------------------------------------------------------------ limiter

/**
 * Counts failures per key in a sliding window. Memory is bounded twice: each
 * key keeps at most `limit` timestamps, and the map holds at most `maxKeys`
 * keys. When it is full, expired keys go first, then the key whose last
 * failure is oldest.
 */
export class FailureLimiter {
	constructor({ limit, windowMs, maxKeys = 10_000, now = Date.now }) {
		this.limit = limit
		this.windowMs = windowMs
		this.maxKeys = maxKeys
		this.now = now
		this.map = new Map() // key -> timestamps, oldest first
	}

	get size() {
		return this.map.size
	}

	#recent(key) {
		const list = this.map.get(key)
		if (!list) return []
		const since = this.now() - this.windowMs
		const recent = list.filter((t) => t > since)
		if (!recent.length) this.map.delete(key)
		else if (recent.length !== list.length) this.map.set(key, recent)
		return recent
	}

	/** True when this key has used up its failures for the window. */
	blocked(key) {
		return this.#recent(key).length >= this.limit
	}

	/** Records one failure for this key. */
	fail(key) {
		const list = [...this.#recent(key), this.now()].slice(-this.limit)
		this.map.delete(key) // re-insert, so map order is "last failure" order
		if (this.map.size >= this.maxKeys) this.prune()
		while (this.map.size >= this.maxKeys) {
			this.map.delete(this.map.keys().next().value)
		}
		this.map.set(key, list)
	}

	/** Drops keys with no failure inside the window. */
	prune() {
		for (const key of [...this.map.keys()]) this.#recent(key)
	}
}
