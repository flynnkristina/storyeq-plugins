#!/usr/bin/env bash
# Tests a Cloudflare Access client secret against the app's token endpoint, without saving it anywhere
# or showing it. Usage: bash scripts/check-access-secret.sh <token endpoint URL>
set -euo pipefail
TOKEN_URL="${1:?give the Token endpoint address}"
ID="$(printf '%s' "$TOKEN_URL" | sed -n 's#.*/oidc/\([A-Za-z0-9]*\)/token$#\1#p')"
[ -n "$ID" ] || { echo "That isn't a Token endpoint address."; exit 1; }
read -r -s -p "Paste the Client secret to test and press Return (nothing will show): " S; echo
S="$(printf '%s' "$S" | tr -d '[:space:]')"
BODY="$(curl -s -X POST "$TOKEN_URL" -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=authorization_code --data-urlencode code=not-a-real-code \
  --data-urlencode "client_id=$ID" --data-urlencode "client_secret=$S")"
unset S
case "$BODY" in
  *"Invalid client secret"*) echo "REFUSED: Cloudflare does not accept this secret for this app." ;;
  *invalid_client*) echo "REFUSED: Cloudflare doesn't recognise this app or secret." ;;
  *) echo "ACCEPTED: the secret is right (Cloudflare only objected to the made-up test code)." ;;
esac
