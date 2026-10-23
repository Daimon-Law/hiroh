// Unit tests for limits.mjs. Run: node --test deploy/access/test/
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	clientAddress,
	DEFAULT_TRUSTED_PROXIES,
	FailureLimiter,
	headerList,
	limitKey,
	trustTest,
} from '../limits.mjs'

const trusted = trustTest(DEFAULT_TRUSTED_PROXIES)
const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers })

test('no headers configured: the TCP peer, whatever the client sends', () => {
	const r = req('203.0.113.9', { 'x-forwarded-for': '1.1.1.1', 'cf-connecting-ip': '2.2.2.2' })
	assert.equal(clientAddress(r, [], trusted), '203.0.113.9')
})

test('headers from a peer that is not a trusted proxy are ignored', () => {
	const r = req('203.0.113.9', { 'cf-connecting-ip': '2.2.2.2' })
	assert.equal(clientAddress(r, headerList('cf-connecting-ip'), trusted), '203.0.113.9')
})

test('x-forwarded-for: the rightmost entry that is not a trusted proxy', () => {
	const h = headerList('x-forwarded-for')
	// Client forged the first entry; Cloudflare/tunnel added the real one;
	// a local proxy added its own address last.
	const r = req('172.18.0.2', { 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 172.18.0.5' })
	assert.equal(clientAddress(r, h, trusted), '198.51.100.7')
	// A LAN visitor: every entry is private, so the leftmost is used.
	const lan = req('172.18.0.2', { 'x-forwarded-for': '192.168.1.20, 172.18.0.5' })
	assert.equal(clientAddress(lan, h, trusted), '192.168.1.20')
	// A malformed entry stops the walk; nothing to its left is trusted.
	const bad = req('172.18.0.2', { 'x-forwarded-for': '6.6.6.6, junk' })
	assert.equal(clientAddress(bad, h, trusted), '172.18.0.2')
})

test('single-value header: used when valid, else the next source', () => {
	const h = headerList('cf-connecting-ip, x-forwarded-for')
	assert.equal(clientAddress(req('::ffff:10.0.0.3', { 'cf-connecting-ip': '198.51.100.8' }), h, trusted), '198.51.100.8')
	assert.equal(
		clientAddress(req('10.0.0.3', { 'cf-connecting-ip': 'nope', 'x-forwarded-for': '198.51.100.9' }), h, trusted),
		'198.51.100.9'
	)
	assert.equal(clientAddress(req('10.0.0.3'), h, trusted), '10.0.0.3')
})

test('IPv6 addresses share a key per /64', () => {
	assert.equal(limitKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64')
	assert.equal(limitKey('2001:db8:1:2:ffff:1:2:3'), '2001:db8:1:2::/64')
	assert.equal(limitKey('2001:db8::1'), '2001:db8:0:0::/64')
	assert.equal(limitKey('198.51.100.7'), '198.51.100.7')
})

test('limiter blocks after the limit and forgets after the window', () => {
	let t = 0
	const l = new FailureLimiter({ limit: 10, windowMs: 1000, now: () => t })
	for (let i = 0; i < 10; i++) {
		assert.equal(l.blocked('a'), false)
		l.fail('a')
	}
	assert.equal(l.blocked('a'), true)
	t = 1001
	assert.equal(l.blocked('a'), false)
	assert.equal(l.size, 0)
})

test('limiter map stays bounded under load', () => {
	let t = 0
	const l = new FailureLimiter({ limit: 10, windowMs: 60_000, maxKeys: 500, now: () => t })
	for (let i = 0; i < 100_000; i++) {
		t += 1
		l.fail(`k${i}`)
		assert.ok(l.size <= 500)
	}
	// Each key keeps at most `limit` timestamps.
	for (let i = 0; i < 1000; i++) l.fail('hot')
	assert.equal(l.map.get('hot').length, 10)
	// Expired keys are dropped by prune().
	t += 60_001
	l.prune()
	assert.equal(l.size, 0)
})
