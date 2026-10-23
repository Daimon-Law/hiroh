// Hiroh access service: decides which devices may use the relay, and runs
// invites for guests. No third-party packages.
//
// The relay (iroh-relay, `access.http` mode) asks it about every device that
// connects: POST with the device's key in a header; the answer "true" allows it.
// A device is allowed when:
//   - a member registered it with a valid relay token (HIROH_RELAY_TOKENS), or
//   - a member approved it through an invite, until the invite's end time.
//
// Two listeners:
//   PORT (8080)        public API under /api, routed by the reverse proxy
//   CHECK_PORT (8081)  relay access check, reachable only inside the stack
//
// Secrets: relay tokens are compared in constant time and never logged.
// Invite secrets and PINs are stored as SHA-256 hashes.
//
// Brute force: wrong PINs and wrong tokens are limited per client address
// (see limits.mjs and HIROH_CLIENT_IP_HEADERS), and every open invite closes
// after PIN_FAILS_PER_INVITE wrong PINs from anyone, whatever their address.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import {
	clientAddress,
	DEFAULT_TRUSTED_PROXIES,
	FailureLimiter,
	headerList,
	limitKey,
	trustTest,
} from './limits.mjs'

const PORT = Number(process.env.PORT || 8080)
const CHECK_PORT = Number(process.env.CHECK_PORT || 8081)
const DATA_DIR = process.env.DATA_DIR || '/data'
const RELAY_URL = (process.env.HIROH_RELAY_URL || '').trim()
const MAX_GUEST_HOURS = Number(process.env.HIROH_MAX_GUEST_HOURS || 168)
// A device with no sign of life for this long loses relay access. Members
// get back in by registering with their token; guests need a new invite.
const DORMANT_MS = Number(process.env.HIROH_DORMANT_HOURS || 24) * 3_600_000
const INVITE_MINUTES = 10
const REQUEST_MINUTES = 3
const PIN_FAILS_PER_WINDOW = 10
const PIN_WINDOW_MS = 15 * 60_000
// Wrong PINs, from all clients together, that close every open invite. A
// wrong PIN cannot tell which invite it was aimed at, so each one counts
// against all of them. Odds of a hit before the close: 100 in 1,000,000.
// Anyone can close open invites this way; the inviter then makes a new one.
const PIN_FAILS_PER_INVITE = 100
const TOKEN_FAILS_PER_WINDOW = 10
const MAX_LIMITER_KEYS = 10_000
const MIN_TOKEN_BITS = 128
const MIN_TOKEN_LENGTH = 24
const MAX_BODY = 16 * 1024

const log = (...a) => console.log(new Date().toISOString(), ...a)
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const now = () => Date.now()

// ------------------------------------------------------------------ tokens

/** Same rules as the relay's entrypoint: "label:token" or "token" entries,
 * separated by commas, semicolons, whitespace or line breaks; quotes ignored. */
function readTokens() {
	const tokens = []
	const entries = String(process.env.HIROH_RELAY_TOKENS || '')
		.replace(/["']/g, '')
		.split(/[\s,;]+/)
		.filter(Boolean)
	entries.forEach((entry, i) => {
		const at = entry.indexOf(':')
		const label = at >= 0 ? entry.slice(0, at) : `entry ${i + 1}`
		const token = at >= 0 ? entry.slice(at + 1) : entry
		const problem = tokenProblem(token)
		if (problem) {
			log(`skipped token '${label}': ${problem}. Make a new one with: openssl rand -hex 24`)
			return
		}
		tokens.push({ label, token, hash: sha256(token) })
	})
	return tokens
}
/** Why a token is too weak to use, or null. The estimate assumes each
 * character was picked at random from the character classes it uses, so it
 * is an upper bound: a guessable token can still pass. Generate tokens. */
function tokenProblem(token) {
	if (!/^[A-Za-z0-9._~+/=-]+$/.test(token)) return 'it has characters that are not allowed'
	if (token.length < MIN_TOKEN_LENGTH) return `it is shorter than ${MIN_TOKEN_LENGTH} characters`
	let pool = 0
	if (/^[0-9]+$/.test(token)) pool = 10
	else if (/^[0-9a-fA-F]+$/.test(token)) pool = 16
	else {
		if (/[0-9]/.test(token)) pool += 10
		if (/[a-z]/.test(token)) pool += 26
		if (/[A-Z]/.test(token)) pool += 26
		if (/[._~+/=-]/.test(token)) pool += 7
	}
	const bits = Math.floor(token.length * Math.log2(pool))
	if (bits < MIN_TOKEN_BITS) return `it has about ${bits} bits of entropy, under ${MIN_TOKEN_BITS}`
	if (new Set(token).size < 10) return 'it repeats too few different characters'
	return null
}

const TOKENS = readTokens()
log(`${TOKENS.length} token(s) loaded: ${TOKENS.map((t) => t.label).join(', ')}`)
if (!TOKENS.length) log('no usable token: members cannot register and invites are off')

function sameString(a, b) {
	const x = Buffer.from(String(a))
	const y = Buffer.from(String(b))
	return x.length === y.length && timingSafeEqual(x, y)
}

/** The member a token belongs to, or null. */
function memberFor(token) {
	if (typeof token !== 'string' || !token) return null
	return TOKENS.find((t) => sameString(t.token, token)) ?? null
}

// ------------------------------------------------------------------ state

/** Persisted: devices allowed on the relay. endpointId -> record */
let devices = {}
const STATE_FILE = join(DATA_DIR, 'state.json')
try {
	devices = JSON.parse(readFileSync(STATE_FILE, 'utf8')).devices ?? {}
} catch {
	devices = {}
}
function save() {
	mkdirSync(DATA_DIR, { recursive: true })
	const tmp = `${STATE_FILE}.tmp`
	writeFileSync(tmp, JSON.stringify({ devices }, null, 1))
	renameSync(tmp, STATE_FILE)
}

/** Set when `seen` times change; written out by prune() once a minute. */
let dirty = false

/** In memory only: open invites and join requests. */
const invites = new Map() // id -> invite
const requests = new Map() // id -> request
/** Wrong PINs and invite links, per client. */
const pinFails = new FailureLimiter({
	limit: PIN_FAILS_PER_WINDOW,
	windowMs: PIN_WINDOW_MS,
	maxKeys: MAX_LIMITER_KEYS,
})
/** Wrong relay tokens, per client. */
const tokenFails = new FailureLimiter({
	limit: TOKEN_FAILS_PER_WINDOW,
	windowMs: PIN_WINDOW_MS,
	maxKeys: MAX_LIMITER_KEYS,
})

function isAllowed(endpointId) {
	const d = devices[endpointId]
	if (!d) return false
	if (d.kind === 'member') {
		// Removing a token from HIROH_RELAY_TOKENS revokes its devices.
		return TOKENS.some((t) => t.hash === d.tokenHash)
	}
	if (d.kind === 'guest') {
		const inviterValid = TOKENS.some((t) => t.hash === d.invitedByHash)
		return inviterValid && d.until > now()
	}
	return false
}

function prune() {
	const t = now()
	// A burned invite stays until it expires, so its inviter can see why.
	for (const [id, inv] of invites)
		if (inv.expiresAt < t || (inv.done && !inv.burned)) invites.delete(id)
	for (const [id, r] of requests)
		if (r.expiresAt + 10 * 60_000 < t) requests.delete(id)
	let changed = dirty
	dirty = false
	for (const [id, d] of Object.entries(devices)) {
		const expired = d.kind === 'guest' && d.until < t
		const dormant = !(d.seen > t - DORMANT_MS)
		if (expired || dormant) {
			delete devices[id]
			changed = true
			if (dormant && !expired)
				log(`removed dormant ${d.kind} device '${d.name || 'unnamed'}'`)
		}
	}
	pinFails.prune()
	tokenFails.prune()
	if (changed) save()
}
setInterval(prune, 60_000).unref()

// ------------------------------------------------------------------ helpers

const ENDPOINT_RE = /^[0-9a-f]{64}$/
const short = (v) => String(v ?? '-').replace(/[\u0000-\u001f\s]/g, '').slice(0, 120) || '-'
/** Origin and path of a URL, without its query or fragment. */
const where = (v) => {
	try {
		const u = new URL(String(v))
		return `${u.origin}${u.pathname}`
	} catch {
		return v // keywords such as "inline", "eval", "wasm-eval"
	}
}
function endpointList(value) {
	if (!Array.isArray(value)) return null
	const list = value.filter((v) => typeof v === 'string' && ENDPOINT_RE.test(v))
	return list.length && list.length <= 4 && list.length === value.length
		? [...new Set(list)]
		: null
}
const cleanName = (v) =>
	typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) : ''
const cleanKind = (v) =>
	['phone', 'tablet', 'laptop', 'desktop'].includes(v) ? v : 'desktop'

function newPin() {
	for (;;) {
		const pin = String(randomInt(0, 1_000_000)).padStart(6, '0')
		const hash = sha256(pin)
		if (![...invites.values()].some((i) => i.pinHash === hash)) return pin
	}
}

/** Short code shown on both screens; the inviter allows only if they match. */
function matchCode(inviteSecretHash, endpoints) {
	const n = Number.parseInt(sha256(`${inviteSecretHash}:${endpoints[0]}`).slice(0, 8), 16)
	return String(n % 10000).padStart(4, '0')
}

// Headers that carry the visitor's address. None by default: the address is
// then the TCP peer, which no client can forge. Name a header only if your
// own reverse proxy sets or overwrites it, and see README.md for the right
// value per deployment. Headers are read only when the TCP peer is one of
// HIROH_TRUSTED_PROXIES (private ranges by default).
const CLIENT_IP_HEADERS = headerList(process.env.HIROH_CLIENT_IP_HEADERS)
const isTrustedProxy = trustTest(
	process.env.HIROH_TRUSTED_PROXIES
		? process.env.HIROH_TRUSTED_PROXIES.split(',').filter((c) => c.trim())
		: DEFAULT_TRUSTED_PROXIES
)
log(
	CLIENT_IP_HEADERS.length
		? `client address from: ${CLIENT_IP_HEADERS.join(', ')} (trusted proxies only)`
		: 'client address from: TCP peer (HIROH_CLIENT_IP_HEADERS not set)'
)

/** The limiter key for this request's client. */
const clientOf = (req) => limitKey(clientAddress(req, CLIENT_IP_HEADERS, isTrustedProxy))

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks = []
		req.on('data', (c) => {
			size += c.length
			if (size > MAX_BODY) {
				reject(new Error('too large'))
				req.destroy()
			} else chunks.push(c)
		})
		req.on('end', () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
			} catch {
				reject(new Error('bad json'))
			}
		})
		req.on('error', reject)
	})
}

function send(res, status, body) {
	res.writeHead(status, {
		'content-type': 'application/json',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	})
	res.end(JSON.stringify(body))
}
const fail = (res, status, error) => send(res, status, { error })

/** The member for the request's token. On a wrong token, answers 401 (429
 * once the client has too many) and returns null. */
function authMember(body, res, req) {
	const client = clientOf(req)
	if (tokenFails.blocked(client)) {
		fail(res, 429, 'Too many wrong access tokens. Wait 15 minutes and try again.')
		return null
	}
	const member = memberFor(body.token)
	if (!member) {
		tokenFails.fail(client)
		fail(res, 401, 'The relay refused this access token.')
		return null
	}
	return member
}

/** A wrong PIN counts against every open invite; closes those at the limit. */
function countWrongPin() {
	const t = now()
	for (const inv of invites.values()) {
		if (inv.done || inv.expiresAt < t) continue
		inv.pinFails += 1
		if (inv.pinFails >= PIN_FAILS_PER_INVITE) {
			// A request already waiting stays open: the inviter still decides.
			inv.done = true
			inv.burned = true
			log(`invite by '${inv.label}' closed after ${inv.pinFails} wrong PINs`)
		}
	}
}

/** CSP violation reports are logged, at most this many per minute. */
let cspBudget = { minute: 0, left: 0 }
const CSP_REPORTS_PER_MINUTE = 30

// ------------------------------------------------------------------ API

const routes = {
	/** Settings test: is this a member's token? Registers nothing. */
	'POST /api/token': (body, res, req) => {
		if (!authMember(body, res, req)) return
		send(res, 200, { ok: true })
	},

	/** A member device registers its keys with its relay token. */
	'POST /api/register': (body, res, req) => {
		const member = authMember(body, res, req)
		if (!member) return
		const endpoints = endpointList(body.endpoints)
		if (!endpoints) return fail(res, 400, 'Bad device keys.')
		for (const id of endpoints) {
			devices[id] = {
				kind: 'member',
				label: member.label,
				tokenHash: member.hash,
				name: cleanName(body.name),
				deviceKind: cleanKind(body.kind),
				seen: now(),
			}
		}
		save()
		send(res, 200, { ok: true })
	},

	/** A member opens an invite: a one-time secret (for links) and a PIN. */
	'POST /api/invites': (body, res, req) => {
		const member = authMember(body, res, req)
		if (!member) return
		const hours = Math.min(MAX_GUEST_HOURS, Math.max(1, Math.round(Number(body.hours) || 24)))
		const id = randomBytes(12).toString('base64url')
		const secret = randomBytes(24).toString('base64url')
		const pin = newPin()
		invites.set(id, {
			id,
			secretHash: sha256(secret),
			pinHash: sha256(pin),
			label: member.label,
			tokenHash: member.hash,
			name: cleanName(body.name) || member.label,
			hours,
			expiresAt: now() + INVITE_MINUTES * 60_000,
			requestId: null,
			pinFails: 0,
			burned: false,
			done: false,
		})
		log(`invite opened by '${member.label}' for ${hours} h`)
		send(res, 200, { id, secret, pin, hours, expiresAt: invites.get(id).expiresAt })
	},

	/** The inviter checks for a join request on its invite. */
	'POST /api/invites/poll': (body, res, req) => {
		const member = authMember(body, res, req)
		if (!member) return
		const inv = invites.get(body.id)
		if (!inv || inv.tokenHash !== member.hash) return send(res, 200, { status: 'gone' })
		const r = inv.requestId ? requests.get(inv.requestId) : null
		send(res, 200, {
			status: inv.burned ? 'burned' : inv.expiresAt < now() ? 'expired' : 'open',
			request:
				r && r.status === 'pending'
					? { id: r.id, name: r.name, kind: r.kind, match: r.match }
					: null,
		})
	},

	/** The inviter allows or denies the device that asked to join. */
	'POST /api/invites/decide': (body, res, req) => {
		const member = authMember(body, res, req)
		if (!member) return
		const r = requests.get(body.requestId)
		const inv = r && invites.get(r.inviteId)
		if (!r || !inv || inv.tokenHash !== member.hash || r.status !== 'pending')
			return fail(res, 404, 'This request is no longer open.')
		if (body.allow === true) {
			if (typeof body.ticket !== 'string' || body.ticket.length > 4000)
				return fail(res, 400, 'Missing pairing code.')
			const until = now() + inv.hours * 3_600_000
			for (const id of r.endpoints) {
				// A device with its own token stays a member; the invite only pairs.
				if (devices[id]?.kind === 'member' && isAllowed(id)) continue
				devices[id] = {
					kind: 'guest',
					name: r.name,
					deviceKind: r.kind,
					invitedBy: member.label,
					invitedByHash: member.hash,
					until,
					seen: now(),
				}
			}
			save()
			r.status = 'approved'
			r.ticket = body.ticket
			r.until = until
			log(`guest approved by '${member.label}' until ${new Date(until).toISOString()}`)
		} else {
			r.status = 'denied'
			log(`guest denied by '${member.label}'`)
		}
		inv.done = true // one attempt per invite
		send(res, 200, { ok: true })
	},

	/** The inviter closes an invite early. */
	'POST /api/invites/cancel': (body, res, req) => {
		const member = authMember(body, res, req)
		if (!member) return
		const inv = invites.get(body.id)
		if (inv && inv.tokenHash === member.hash) {
			inv.done = true
			const r = inv.requestId && requests.get(inv.requestId)
			if (r && r.status === 'pending') r.status = 'denied'
		}
		send(res, 200, { ok: true })
	},

	/** A guest uses an invite link or PIN and asks to join. */
	'POST /api/join': (body, res, req) => {
		const client = clientOf(req)
		if (pinFails.blocked(client))
			return fail(res, 429, 'Too many wrong codes. Wait 15 minutes and try again.')
		const endpoints = endpointList(body.endpoints)
		if (!endpoints) return fail(res, 400, 'Bad device keys.')
		let inv = null
		let byPin = false
		if (typeof body.secret === 'string' && body.secret) {
			const h = sha256(body.secret)
			inv = [...invites.values()].find((i) => i.secretHash === h) ?? null
		} else if (typeof body.pin === 'string' && /^\d{6}$/.test(body.pin)) {
			byPin = true
			const h = sha256(body.pin)
			inv = [...invites.values()].find((i) => i.pinHash === h) ?? null
		}
		if (!inv || inv.done || inv.expiresAt < now()) {
			pinFails.fail(client)
			if (byPin) countWrongPin()
			return fail(res, 404, 'This code does not work. Ask for a new one.')
		}
		const open = inv.requestId && requests.get(inv.requestId)
		if (open && open.status === 'pending')
			return fail(res, 409, 'Someone is already using this code. Ask for a new one.')
		const id = randomBytes(16).toString('base64url')
		const r = {
			id,
			inviteId: inv.id,
			name: cleanName(body.name) || 'Guest device',
			kind: cleanKind(body.kind),
			endpoints,
			match: matchCode(inv.secretHash, endpoints),
			status: 'pending',
			expiresAt: now() + REQUEST_MINUTES * 60_000,
			ticket: null,
			until: null,
		}
		requests.set(id, r)
		inv.requestId = id
		send(res, 200, {
			requestId: id,
			match: r.match,
			inviter: inv.name,
			expiresAt: r.expiresAt,
		})
	},

	/** The guest waits for the inviter's answer. */
	'POST /api/join/poll': (body, res) => {
		const r = requests.get(body.requestId)
		if (!r) return send(res, 200, { status: 'gone' })
		if (r.status === 'pending' && r.expiresAt < now()) r.status = 'expired'
		send(res, 200, {
			status: r.status,
			...(r.status === 'approved'
				? { ticket: r.ticket, until: r.until, relayUrl: RELAY_URL || null }
				: {}),
		})
	},

	/** A member lists the guests it let in. */
	'POST /api/guests': (body, res, req) => {
		const member = authMember(body, res, req)
		if (!member) return
		const seen = new Map()
		for (const [id, d] of Object.entries(devices)) {
			if (d.kind !== 'guest' || d.invitedByHash !== member.hash || d.until < now()) continue
			const key = `${d.name}|${d.until}`
			const g = seen.get(key) ?? { name: d.name, kind: d.deviceKind, until: d.until, endpoints: [] }
			g.endpoints.push(id)
			seen.set(key, g)
		}
		send(res, 200, { guests: [...seen.values()] })
	},

	/** A member ends a guest's access early. */
	'POST /api/guests/revoke': (body, res, req) => {
		const member = authMember(body, res, req)
		if (!member) return
		const ids = endpointList(body.endpoints) ?? []
		for (const id of ids) {
			const d = devices[id]
			if (d?.kind === 'guest' && d.invitedByHash === member.hash) delete devices[id]
		}
		save()
		send(res, 200, { ok: true })
	},

	/** An open Hiroh page says it is still in use. Only refreshes devices that
	 * are already allowed; it never grants access. */
	'POST /api/seen': (body, res) => {
		const ids = endpointList(body.endpoints) ?? []
		const t = now()
		for (const id of ids) {
			if (isAllowed(id)) {
				devices[id].seen = t
				dirty = true
			}
		}
		send(res, 200, { ok: true })
	},

	/** Content-Security-Policy violation reports from browsers (report-uri and
	 * Reporting API formats). Logs where the violation was, never page data. */
	'POST /api/csp-report': (body, res) => {
		const minute = Math.floor(now() / 60_000)
		if (cspBudget.minute !== minute) cspBudget = { minute, left: CSP_REPORTS_PER_MINUTE }
		const reports = Array.isArray(body) ? body.map((r) => r?.body) : [body?.['csp-report']]
		for (const r of reports.slice(0, 10)) {
			if (!r || typeof r !== 'object' || cspBudget.left <= 0) continue
			cspBudget.left -= 1
			const directive = r.effectiveDirective || r['effective-directive'] || r['violated-directive']
			const blocked = r.blockedURL || r['blocked-uri']
			const page = r.documentURL || r['document-uri']
			log(`csp ${short(r.disposition)} ${short(directive)} blocked ${short(where(blocked))} on ${short(where(page))}`)
		}
		res.writeHead(204, { 'cache-control': 'no-store' })
		res.end()
	},

	'GET /api/health': (_body, res) => send(res, 200, { ok: true }),
}

createServer(async (req, res) => {
	const path = (req.url || '').split('?')[0]
	const route = routes[`${req.method} ${path}`]
	if (!route) return fail(res, 404, 'Not found.')
	try {
		const body = req.method === 'POST' ? await readBody(req) : {}
		await route(body, res, req)
	} catch (e) {
		fail(res, 400, e instanceof Error ? e.message : 'Bad request.')
	}
}).listen(PORT, () => log(`api on :${PORT}`))

// Relay access check: internal only. Answers "true" to allow.
createServer((req, res) => {
	// iroh-relay 1.0 documents X-Iroh-Endpoint-Id but sends X-Iroh-NodeId
	// (src/main.rs, X_IROH_ENDPOINT_ID). Accept both.
	const id = String(
		req.headers['x-iroh-endpoint-id'] || req.headers['x-iroh-nodeid'] || ''
	)
	const ok = req.method === 'POST' && ENDPOINT_RE.test(id) && isAllowed(id)
	if (process.env.HIROH_ACCESS_DEBUG) log(`check ${req.method} ${req.url} ${JSON.stringify(id)} -> ${ok}`)
	if (ok && devices[id]) {
		devices[id].seen = now()
		dirty = true
	}
	res.writeHead(ok ? 200 : 403, { 'content-type': 'text/plain' })
	res.end(ok ? 'true' : 'false')
}).listen(CHECK_PORT, () => log(`relay check on :${CHECK_PORT}`))
