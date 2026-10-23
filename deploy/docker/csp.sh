#!/bin/sh
# Writes the Content-Security-Policy header for nginx when the container
# starts (nginx runs /docker-entrypoint.d/* before it starts).
#
#   HIROH_CSP                 report (default): Content-Security-Policy-Report-Only
#                             enforce: Content-Security-Policy
#                             off: no header
#   HIROH_CSP_CONNECT_EXTRA   Extra connect-src sources, space separated, for
#                             relays on other hosts, e.g.
#                             "https://relay.example.com wss://relay.example.com"
#
# Browsers send violation reports to /api/csp-report; the access service logs
# them. Run in report mode, use the app (pair, send, invite, scan a QR code),
# check the access log for "csp" lines, then switch to enforce.
set -eu
OUT=/etc/nginx/hiroh-csp.conf

extra=${HIROH_CSP_CONNECT_EXTRA:-}
case $extra in
*[!A-Za-z0-9:/.*_\ -]*)
	echo "hiroh-csp: HIROH_CSP_CONNECT_EXTRA has characters that are not allowed" >&2
	exit 1
	;;
esac

# 'wasm-unsafe-eval' lets the page compile Hiroh's WebAssembly engine; it does
# not allow eval(). dns.iroh.link is iroh's address lookup; the n0 relays are
# the public relays. 'self' covers this site's own relay and API.
policy="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' https://dns.iroh.link https://*.relay.n0.iroh.link wss://*.relay.n0.iroh.link${extra:+ $extra}; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; report-uri /api/csp-report"

case ${HIROH_CSP:-report} in
report) header=Content-Security-Policy-Report-Only ;;
enforce) header=Content-Security-Policy ;;
off)
	: >"$OUT"
	echo "hiroh-csp: off"
	exit 0
	;;
*)
	echo "hiroh-csp: HIROH_CSP must be report, enforce or off" >&2
	exit 1
	;;
esac

printf 'add_header %s "%s" always;\n' "$header" "$policy" >"$OUT"
echo "hiroh-csp: $header"
