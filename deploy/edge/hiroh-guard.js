// hiroh-guard: a Cloudflare Worker that blocks an IP address at the edge after
// repeated wrong invite codes. Optional; Hiroh works without it.
//
// Setup (Cloudflare dashboard, Free plan is enough):
//   1. Storage & databases → KV → create a namespace, e.g. "hiroh-guard".
//   2. Workers → create a Worker from this file. Settings → Bindings → add the
//      KV namespace with the variable name GUARD.
//   3. Settings → Domains & Routes → add the route  <your host>/*
//   4. Exempt the relay so file transfers never pass through the Worker: add
//      routes <your host>/relay*, <your host>/ping and <your host>/generate_204
//      with no Worker (Workers Routes → "None").
//
// The access service answers 404 to a wrong code and 429 when it is already
// limiting a client. Each of those counts as a failure here.

const MAX_FAILS = 5 // wrong codes before the block
const FAIL_WINDOW_S = 15 * 60 // a failure is forgotten after this long
const BLOCK_S = 24 * 60 * 60 // how long a blocked address stays blocked

export default {
	async fetch(request, env, ctx) {
		const ip = request.headers.get('cf-connecting-ip') || ''

		if (ip && (await read(env, `block:${ip}`))) {
			return new Response(
				'This address is blocked for 24 hours after too many wrong invite codes.\n',
				{
					status: 403,
					headers: {
						'content-type': 'text/plain; charset=utf-8',
						'cache-control': 'no-store',
					},
				}
			)
		}

		const response = await fetch(request)

		const { pathname } = new URL(request.url)
		if (
			ip &&
			request.method === 'POST' &&
			pathname === '/api/join' &&
			(response.status === 404 || response.status === 429)
		) {
			ctx.waitUntil(countFailure(env, ip))
		}
		return response
	},
}

/** KV trouble must never take the site down: fail open. */
async function read(env, key) {
	try {
		return await env.GUARD.get(key)
	} catch {
		return null
	}
}

async function countFailure(env, ip) {
	try {
		const key = `fail:${ip}`
		const fails = Number(await env.GUARD.get(key)) + 1
		if (fails >= MAX_FAILS) {
			await env.GUARD.put(`block:${ip}`, new Date().toISOString(), {
				expirationTtl: BLOCK_S,
			})
			await env.GUARD.delete(key)
		} else {
			await env.GUARD.put(key, String(fails), { expirationTtl: FAIL_WINDOW_S })
		}
	} catch {
		// Fail open; the access service still limits wrong codes per address.
	}
}
