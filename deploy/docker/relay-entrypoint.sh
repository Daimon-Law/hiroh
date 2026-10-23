#!/bin/sh
# Builds the iroh-relay access list from environment variables, then starts
# the relay. Token values are never printed.
#
#   HIROH_RELAY_TOKENS        One or more tokens. Each entry is "label:token" or
#                            "token". The label is a note for you (for example
#                            a person's name) and is not sent by clients.
#
# Commas, semicolons, spaces, tabs and line breaks all separate entries, and
# quotes are ignored, so a list pasted from a terminal works as is.
# A token may contain letters, digits and . _ ~ + / = - and must be at least
# 24 characters long. (The access service also checks its entropy.) An entry that breaks these rules is skipped with a
# warning. The relay starts only if at least one token is valid.
# Generate a token with: openssl rand -hex 24
#
#   HIROH_ACCESS_URL          If set, the relay asks the Hiroh access service at
#                            this URL about every device (iroh-relay
#                            access.http mode) and the token list above is
#                            used by that service instead. Needed for invites.
set -eu
# Entries are split on whitespace; never expand them as file name patterns.
set -f

CONFIG=/tmp/iroh-relay.toml
TEMPLATE=/config/iroh-relay.toml

tokens=""
count=0
labels=""
skipped=0

add_token() {
	label=$1
	token=$2
	case $token in
	*[!A-Za-z0-9._~+/=-]*)
		echo "hiroh-relay: skipped '$label': token has characters that are not allowed" >&2
		skipped=$((skipped + 1))
		return
		;;
	esac
	if [ "${#token}" -lt 24 ]; then
		echo "hiroh-relay: skipped '$label': token is shorter than 24 characters" >&2
		skipped=$((skipped + 1))
		return
	fi
	tokens="$tokens${tokens:+, }\"$token\""
	count=$((count + 1))
	labels="$labels${labels:+, }$label"
}

# Reads entries from one variable. $1 names the variable for messages.
read_list() {
	n=0
	for entry in $(printf '%s' "$2" | tr ',;\r\n\t' '     ' | tr -d "\"'"); do
		n=$((n + 1))
		case $entry in
		*:*) add_token "${entry%%:*}" "${entry#*:}" ;;
		*) add_token "$1 entry $n" "$entry" ;;
		esac
	done
}

read_list HIROH_RELAY_TOKENS "${HIROH_RELAY_TOKENS:-}"
unset HIROH_RELAY_TOKENS

if [ -n "${HIROH_ACCESS_URL:-}" ]; then
	case $HIROH_ACCESS_URL in
	http://* | https://*) ;;
	*)
		echo "hiroh-relay: HIROH_ACCESS_URL must start with http:// or https://" >&2
		exit 1
		;;
	esac
	grep -v '^access\.shared_token' "$TEMPLATE" >"$CONFIG.body"
	{
		echo "access.http.url = \"$HIROH_ACCESS_URL\""
		cat "$CONFIG.body"
	} >"$CONFIG"
	rm -f "$CONFIG.body"
	echo "hiroh-relay: access decided by $HIROH_ACCESS_URL"
	exec /iroh-relay --dev --config-path "$CONFIG"
fi

if [ "$count" -eq 0 ]; then
	echo "hiroh-relay: no valid token; set HIROH_RELAY_TOKENS (see .env.example)" >&2
	exit 1
fi

# Replace the placeholder access line in the template with the real list.
grep -v '^access\.shared_token' "$TEMPLATE" >"$CONFIG.body"
{
	echo "access.shared_token = [$tokens]"
	cat "$CONFIG.body"
} >"$CONFIG"
rm -f "$CONFIG.body"
chmod 600 "$CONFIG"

note=""
[ "$skipped" -gt 0 ] && note=" ($skipped skipped, see above)"
echo "hiroh-relay: $count token(s) loaded: $labels$note"
exec /iroh-relay --dev --config-path "$CONFIG"
