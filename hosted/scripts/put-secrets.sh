#!/bin/bash
# Puts this deploy's secrets on Cloudflare without them ever being shown or saved in a file.
#
#   bash scripts/put-secrets.sh <wrangler config> keys      the three Google keys, from this Mac's Keychain
#   bash scripts/put-secrets.sh <wrangler config> access    the Access app's five values (you paste each one)
#   bash scripts/put-secrets.sh <wrangler config> one NAME  just one value, e.g. ACCESS_CLIENT_SECRET
#   bash scripts/put-secrets.sh <wrangler config> keyfiles WRITER.json READER.json EVALBOT.json
#        three downloaded Google key files: each is checked (right account, one project), sent to
#        Cloudflare, then deleted from this Mac so no key stays on the laptop
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
    read -r -s -p "Paste $1$(label "$1") and press Return (nothing will show): " VALUE; echo
    VALUE="$(printf '%s' "$VALUE" | tr -d '[:space:]')"
    [ -n "$VALUE" ] || { echo "  (nothing came through - paste again, or press Ctrl+C to stop)"; continue; }
    looks_right "$1" "$VALUE" || VALUE=""
  done
}

# The name each value has on the Cloudflare app's page.
label() {
  case "$1" in
    ACCESS_CLIENT_ID) echo " (Cloudflare calls it: Client ID)" ;;
    ACCESS_CLIENT_SECRET) echo " (Cloudflare calls it: Client secret)" ;;
    ACCESS_TOKEN_URL) echo " (Cloudflare calls it: Token endpoint)" ;;
    ACCESS_AUTHORIZATION_URL) echo " (Cloudflare calls it: Authorization endpoint)" ;;
    ACCESS_JWKS_URL) echo " (Cloudflare calls it: Key endpoint)" ;;
  esac
}

# Each sign-in value has a shape; a value pasted into the wrong slot is caught here, before it's saved.
# The messages never repeat what was pasted.
looks_right() {
  local oidc='^https://[a-z0-9-]+\.cloudflareaccess\.com/cdn-cgi/access/sso/oidc/[A-Za-z0-9]+/'
  case "$1" in
    ACCESS_AUTHORIZATION_URL) [[ "$2" =~ ${oidc}authorization$ ]] && return 0; echo "  That isn't the Authorization endpoint (it starts https:// and ends /authorization). Paste again." ;;
    ACCESS_TOKEN_URL) [[ "$2" =~ ${oidc}token$ ]] && return 0; echo "  That isn't the Token endpoint (it starts https:// and ends /token). Paste again." ;;
    ACCESS_JWKS_URL) [[ "$2" =~ ${oidc}jwks$ ]] && return 0; echo "  That isn't the Key endpoint (it starts https:// and ends /jwks). Paste again." ;;
    ACCESS_CLIENT_ID|ACCESS_CLIENT_SECRET) [[ "$2" =~ ^[A-Za-z0-9._-]{16,}$ && "$2" != http* ]] && return 0; echo "  That doesn't look like the $1 (a long run of letters and numbers, not a web address). Paste again." ;;
    *) return 0 ;;
  esac
  return 1
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
    # Ask for all five first and check they belong to the same Cloudflare app before saving any.
    ask ACCESS_CLIENT_ID; V_ID="$VALUE"
    ask ACCESS_CLIENT_SECRET; V_SECRET="$VALUE"
    ask ACCESS_TOKEN_URL; V_TOKEN="$VALUE"
    ask ACCESS_AUTHORIZATION_URL; V_AUTH="$VALUE"
    ask ACCESS_JWKS_URL; V_JWKS="$VALUE"
    unset VALUE
    for U in "$V_TOKEN" "$V_AUTH" "$V_JWKS"; do
      case "$U" in
        */oidc/"$V_ID"/*) ;;
        *) echo "The three endpoints and the Client ID don't all come from the same Cloudflare app. Nothing was saved. Copy all five from one app's page and run this again."; exit 1 ;;
      esac
    done
    [ "$V_SECRET" != "$V_ID" ] || { echo "The Client secret is the same as the Client ID, so one was pasted twice. Nothing was saved."; exit 1; }
    printf '%s' "$V_ID" | put ACCESS_CLIENT_ID
    printf '%s' "$V_SECRET" | put ACCESS_CLIENT_SECRET
    printf '%s' "$V_TOKEN" | put ACCESS_TOKEN_URL
    printf '%s' "$V_AUTH" | put ACCESS_AUTHORIZATION_URL
    printf '%s' "$V_JWKS" | put ACCESS_JWKS_URL
    unset V_ID V_SECRET V_TOKEN V_AUTH V_JWKS
    ;;
  one)
    NAME="${3:?say which secret, e.g. ACCESS_CLIENT_SECRET}"
    ask "$NAME"
    printf '%s' "$VALUE" | put "$NAME"
    unset VALUE
    ;;
  keyfiles)
    acct() { /usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("client_email",""))' "$1" 2>/dev/null; }
    # With no file names, look in Downloads for the newest key file for each account.
    find_key() {
      local f best=""
      for f in $(ls -t "$HOME/Downloads"/*.json 2>/dev/null); do
        case "$(acct "$f")" in *"library-$1@"*) best="$f"; break ;; esac
      done
      echo "$best"
    }
    W="${3:-$(find_key writer)}"; R="${4:-$(find_key reader)}"; E="${5:-$(find_key evalbot)}"
    for PAIR in "$W|writer" "$R|reader" "$E|evalbot"; do
      IFS='|' read -r FILE ROLE <<<"$PAIR"
      [ -n "$FILE" ] || { echo "Couldn't find a library-$ROLE key file in Downloads, stopping. Nothing was set."; exit 1; }
    done
    proj() { acct "$1" | sed -n 's/.*@\(.*\)\.iam\.gserviceaccount\.com/\1/p'; }
    for PAIR in "$W|writer" "$R|reader" "$E|evalbot"; do
      IFS='|' read -r FILE ROLE <<<"$PAIR"
      [ -f "$FILE" ] || { echo "No file at $FILE, stopping. Nothing was set."; exit 1; }
      case "$(acct "$FILE")" in *"library-$ROLE@"*) ;; *) echo "$FILE isn't the library-$ROLE account's key, stopping. Nothing was set."; exit 1 ;; esac
    done
    [ "$(proj "$W")" = "$(proj "$R")" ] && [ "$(proj "$W")" = "$(proj "$E")" ] || { echo "The three keys come from different Google projects, stopping. Nothing was set."; exit 1; }
    put WRITER_KEY < "$W"; put READER_KEY < "$R"; put EVALBOT_KEY < "$E"
    rm -f "$W" "$R" "$E" && echo "deleted the three key files from this Mac"
    ;;
  *) echo "Say keys, access, one or keyfiles"; exit 1 ;;
esac
echo "done"
