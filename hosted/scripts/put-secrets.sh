#!/bin/bash
# Puts this deploy's secrets on Cloudflare without them ever being shown or saved in a file.
#
#   bash scripts/put-secrets.sh <wrangler config> keys      the three Google keys, from this Mac's Keychain
#   bash scripts/put-secrets.sh <wrangler config> access    the Access app's five values (you paste each one)
#   bash scripts/put-secrets.sh <wrangler config> one NAME  just one value, e.g. ACCESS_CLIENT_SECRET
#
# "keys" reads the keys the plugin already keeps in the Keychain and hands each one straight to
# Cloudflare. "access" asks for each value with typing hidden, then makes the cookie key itself.
# Prints only the names of what it set. Run it yourself, in your own terminal.
set -euo pipefail
CONFIG="${1:?say which wrangler config, e.g. wrangler.storyeq-test.jsonc}"
WHAT="${2:?say keys or access}"
PLUGIN="${LIBRARY_PLUGIN:-kristina-os}"
WRANGLER="${WRANGLER:-wrangler}"
cd "$(dirname "$0")/.."

# Asks until something is pasted: an empty Return (a stray keypress) just asks again.
ask() {
  VALUE=""
  while [ -z "$VALUE" ]; do
    read -r -s -p "Paste $1 and press Return (nothing will show): " VALUE; echo
    [ -n "$VALUE" ] || echo "  (nothing came through - paste again, or press Ctrl+C to stop)"
  done
}

put() { "$WRANGLER" secret put "$1" -c "$CONFIG" >/dev/null 2>&1 && echo "set $1" || { echo "FAILED to set $1"; exit 1; }; }

from_keychain() {
  /usr/bin/security find-generic-password -s "$1" -a "$2" -w 2>/dev/null | /usr/bin/base64 -D
}

case "$WHAT" in
  keys)
    from_keychain "StoryEQ library key" "$PLUGIN" | put WRITER_KEY
    from_keychain "StoryEQ library key (reader)" "$PLUGIN" | put READER_KEY
    from_keychain "StoryEQ library key" "$PLUGIN:evalbot" | put EVALBOT_KEY
    ;;
  access)
    for NAME in ACCESS_CLIENT_ID ACCESS_CLIENT_SECRET ACCESS_TOKEN_URL ACCESS_AUTHORIZATION_URL ACCESS_JWKS_URL; do
      ask "$NAME"
      printf '%s' "$VALUE" | put "$NAME"
      unset VALUE
    done
    /usr/bin/openssl rand -hex 32 | tr -d '\n' | put COOKIE_ENCRYPTION_KEY
    ;;
  one)
    NAME="${3:?say which secret, e.g. ACCESS_CLIENT_SECRET}"
    ask "$NAME"
    printf '%s' "$VALUE" | put "$NAME"
    unset VALUE
    ;;
  *) echo "Say keys, access or one"; exit 1 ;;
esac
echo "done"
