// Black-box tests for server.mjs: each test starts the real service.
// Run: node --test deploy/access/test/
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const SERVER = new URL('../server.mjs', import.meta.url).pathname
const TOKEN = randomBytes(24).toString('hex')
const KEYS = ['a'.repeat(64)]
const running = []

after(() => {
	for (const { child, dir } of running) {
		child.kill()
		rmSync(dir, { recursive: true, force: true })
	}
})

/** Starts the service; resolves once both ports listen. */
async function start(env = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'hiroh-access-'))
	const port = 20000 + Math.floor(Math.random() * 20000)
	const child = spawn(process.execPath, [SERVER], {
		env: {
			PATH: process.env.PATH,
			PORT: String(port),
			CHECK_PORT: String(port + 1),
			DATA_DIR: dir,
			HIROH_RELAY_TOKENS: `alice:${TOKEN}`,
			...env,
		},
	})
	let out = ''
	child.stdout.on('data', (d) => {
		out += d
	})
	child.stderr.on('data', (d) => {
		out += d
	})
	running.push({ child, dir })
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no start:\n${out}`)), 5000)
		const check = () => {
			if (out.includes('relay check on')) {
				clearTimeout(timer)
				resolve()
			} else setTimeout(check, 20)
		}
		check()
	})
	const post = async (path, body, headers = {}) => {
		const res = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body),
		})
		return { status: res.status, body: await res.json().catch(() => null) }
	}
	return { post, log: () => out }
}

const wrongPin = (real, i) => String((Number(real) + 1 + i) % 1_000_000).padStart(6, '0')

test('default config: forged header rotation still hits 429 after 10 failures', async () => {
	const { post } = await start()
	const statuses = []
	for (let i = 0; i < 25; i++) {
		const r = await post(
			'join',
			{ pin: '000000', endpoints: KEYS },
			{
				'x-forwarded-for': `203.0.113.${i}`,
				'cf-connecting-ip': `198.51.100.${i}`,
				'x-real-ip': `192.0.2.${i}`,
			}
		)
		statuses.push(r.status)
	}
	assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404))
	assert.deepEqual(statuses.slice(10), Array(15).fill(429))
})

test('x-forwarded-for configured: forged first entries do not reset the limit', async () => {
	const { post } = await start({ HIROH_CLIENT_IP_HEADERS: 'x-forwarded-for' })
	const statuses = []
	for (let i = 0; i < 25; i++) {
		// The client forges the first entry; "its" proxy appended the real one.
		const r = await post(
			'join',
			{ pin: '000000', endpoints: KEYS },
			{ 'x-forwarded-for': `203.0.113.${i}, 198.51.100.50` }
		)
		statuses.push(r.status)
	}
	assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404))
	assert.deepEqual(statuses.slice(10), Array(15).fill(429))
	// A different real visitor still has their own budget.
	const other = await post('join', { pin: '000000', endpoints: KEYS }, { 'x-forwarded-for': '198.51.100.51' })
	assert.equal(other.status, 404)
})

test('an invite burns after 100 wrong PINs, whatever the source address', async () => {
	const { post, log } = await start({ HIROH_CLIENT_IP_HEADERS: 'cf-connecting-ip' })
	const inv = await post('invites', { token: TOKEN, hours: 1 })
	assert.equal(inv.status, 200)
	for (let i = 0; i < 100; i++) {
		// A new address every time, so the per-address limit never applies.
		const r = await post(
			'join',
			{ pin: wrongPin(inv.body.pin, i), endpoints: KEYS },
			{ 'cf-connecting-ip': `198.51.${100 + Math.floor(i / 250)}.${i % 250}` }
		)
		assert.equal(r.status, 404)
	}
	const right = await post(
		'join',
		{ pin: inv.body.pin, endpoints: KEYS },
		{ 'cf-connecting-ip': '198.51.100.200' }
	)
	assert.equal(right.status, 404, 'the correct PIN must no longer work')
	const poll = await post('invites/poll', { token: TOKEN, id: inv.body.id })
	assert.equal(poll.body.status, 'burned')
	assert.match(log(), /closed after 100 wrong PINs/)
})

test('an invite survives fewer wrong PINs than the limit', async () => {
	const { post } = await start({ HIROH_CLIENT_IP_HEADERS: 'cf-connecting-ip' })
	const inv = await post('invites', { token: TOKEN, hours: 1 })
	for (let i = 0; i < 99; i++)
		await post('join', { pin: wrongPin(inv.body.pin, i), endpoints: KEYS }, { 'cf-connecting-ip': `198.51.100.${i}` })
	const right = await post('join', { pin: inv.body.pin, endpoints: KEYS }, { 'cf-connecting-ip': '198.51.100.200' })
	assert.equal(right.status, 200)
})

test('/api/token is throttled: 10 wrong tokens, then 429', async () => {
	const { post } = await start()
	const statuses = []
	for (let i = 0; i < 12; i++) statuses.push((await post('token', { token: `wrong-${i}` })).status)
	assert.deepEqual(statuses, [...Array(10).fill(401), 429, 429])
})

test('the right token still works before the limit', async () => {
	const { post } = await start()
	assert.equal((await post('token', { token: TOKEN })).status, 200)
})

test('weak relay tokens are rejected at startup', async () => {
	const { post, log } = await start({
		HIROH_RELAY_TOKENS: `alice:${TOKEN},short:abc123,digits:123412341234123412341234,same:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
	})
	assert.match(log(), /skipped token 'short': it is shorter than 24/)
	assert.match(log(), /skipped token 'digits': it has about 79 bits/)
	assert.match(log(), /skipped token 'same'/)
	assert.match(log(), /1 token\(s\) loaded: alice/)
	assert.equal((await post('token', { token: '123412341234123412341234' })).status, 401)
	assert.doesNotMatch(log(), new RegExp(TOKEN))
})

test('CSP report fields cannot inject log lines', async () => {
	const { post, log } = await start()
	await post('csp-report', {
		'csp-report': { disposition: 'x\n2026-01-01T00:00:00.000Z invite by bob closed', 'blocked-uri': 'a\nb' },
	})
	assert.doesNotMatch(log(), /\n2026-01-01T00:00:00\.000Z invite by bob/)
})

test('CSP reports are accepted and logged without query strings', async () => {
	const { post, log } = await start()
	const r = await post('csp-report', {
		'csp-report': {
			'document-uri': 'https://hiroh.example/?secret=1',
			'effective-directive': 'connect-src',
			'blocked-uri': 'wss://evil.example/x?y=2',
		},
	})
	assert.equal(r.status, 204)
	assert.match(log(), /csp - connect-src blocked wss:\/\/evil\.example\/x on https:\/\/hiroh\.example\//)
	assert.doesNotMatch(log(), /secret=1|y=2/)
})
