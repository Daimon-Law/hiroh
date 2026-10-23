# Changelog

## 1.0.1 (unreleased): security fix

### Fixed: invite PINs could be brute-forced past the rate limit (Medium)

The access service limits wrong invite PINs to 10 per address in 15 minutes.
Before this release it took the address from `cf-connecting-ip` or the first
`X-Forwarded-For` entry by default. A client can send any value in those
headers, so where no proxy in front of Hiroh replaced them, a new fake value
on each request got a new allowance. That made it possible to try all
1,000,000 PINs during the 10 minutes an invite is open. The record of
failures also grew without limit.

**Are you affected?** Probably, if all of these hold on 1.0.0:

- you did not set `HIROH_CLIENT_IP_HEADERS`, or set it to include
  `x-forwarded-for` or `cf-connecting-ip`, and
- Hiroh was reachable through a proxy that passes those headers through
  unchanged. A common case: plain HTTP (`HIROH_SITE_ADDRESS=:80`) behind a
  generic reverse proxy that appends to `X-Forwarded-For`, or `cf-connecting-ip`
  trusted while the origin is reachable without Cloudflare.

A successful guess lets a stranger ask to join; the inviter still has to
allow the request after comparing a 4-digit match code. File and message
content stays end-to-end encrypted either way.

**What changed:**

- `HIROH_CLIENT_IP_HEADERS` now defaults to empty: the TCP peer address.
  The bundled compose files still set `x-forwarded-for`, which is correct for
  them.
- Headers are read only from trusted proxies (`HIROH_TRUSTED_PROXIES`,
  private ranges by default).
- `X-Forwarded-For` is read from the right: the first address that is not a
  trusted proxy. Client-sent entries on the left are ignored.
- IPv6 addresses are limited per /64.
- Every open invite now closes after 100 wrong PINs in total, from any
  address. The inviter sees why and makes a new invite.
- The bundled Caddy no longer trusts `X-Forwarded-For` from every private
  address. That let LAN clients fake their address, and every internet
  client too where Docker's userland proxy shows them as a gateway address.
  Behind your own proxy or tunnel, set `HIROH_CADDY_TRUSTED_PROXIES` to it.
- The failure records expire after 15 minutes and are capped at 10,000
  addresses.

**What to do:** update, then set `HIROH_CLIENT_IP_HEADERS` for your setup
from the table in [README.md](README.md#client-addresses). Behind
Cloudflare, use `cf-connecting-ip` and make sure the origin cannot be reached
without Cloudflare.

### Hardening

- Wrong relay tokens are limited per address too (10 in 15 minutes), on
  `/api/token` and every other endpoint that takes a token.
- Relay tokens must be at least 24 characters with about 128 bits of entropy.
  Weaker tokens are skipped at start-up with a line in the access log naming
  the label. Check that log after you update; replace any skipped token with
  `openssl rand -hex 24`.
- The web app sends a Content-Security-Policy, in report-only mode by
  default (`HIROH_CSP=report`). Violations are logged by the access service.
  Switch to `HIROH_CSP=enforce` once a session of normal use logs none.
- `deploy/edge/hiroh-guard.js` now documents a route on `/api/*` only.
  If you route it on the whole host, change the route.
