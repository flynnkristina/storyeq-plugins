#!/bin/bash
# Puts this deploy's secrets on Cloudflare without them ever being shown or saved in a file.
#
#   bash scripts/put-secrets.sh <wrangler config> keys      the three Google keys, from this Mac's Keychain
#   bash scripts/put-secrets.sh <wrangler config> access    the Access app's five values (you paste each one)
#   bash scripts/put-secrets.sh <wrangler config> one NAME  just one value, e.g. ACCESS_CLIENT_SECRET
#
# "keys" reads the keys the plugin already keeps in the Keychain and hands each one straight to
# Cloudflare. "access" asks for each value with typing hidden.
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
  # Stops before anything reaches Cloudflare if the Keychain item isn't there, so an empty value
  # is never uploaded and "set ..." is never printed for something that wasn't set.
  /usr/bin/security find-generic-password -s "$1" -a "$2" >/dev/null 2>&1 || { echo "No Keychain item \"$1\" for $2, stopping." >&2; exit 1; }
  /usr/bin/security find-generic-password -s "$1" -a "$2" -w 2>/dev/null | /usr/bin/base64 -D
}

case "$WHAT" in
  keys)
    for ITEM in "WRITER_KEY|StoryEQ library key|$PLUGIN" "READER_KEY|StoryEQ library key (reader)|$PLUGIN" "EVALBOT_KEY|StoryEQ library key|$PLUGIN:evalbot"; do
      IFS='|' read -r NAME SERVICE ACCOUNT <<<"$ITEM"
      /usr/bin/security find-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1 || { echo "No Keychain item \"$SERVICE\" for $ACCOUNT, stopping. Nothing was set for $NAME."; exit 1; }
      from_keychain "$SERVICE" "$ACCOUNT" | put "$NAME"
    done
    ;;
  access)
    for NAME in ACCESS_CLIENT_ID ACCESS_CLIENT_SECRET ACCESS_TOKEN_URL ACCESS_AUTHORIZATION_URL ACCESS_JWKS_URL; do
      ask "$NAME"
      printf '%s' "$VALUE" | put "$NAME"
      unset VALUE
    done
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
