# Hosted library connector (Cloudflare)

The library connector as a hosted service, so nobody installs a plugin or keeps a key on their
laptop. One Cloudflare Worker serves three addresses, and each is added in Claude as its own
custom connector:

| Address | Who can sign in | What it can do | Google key it uses |
|---|---|---|---|
| `/team` (`TEAM_PATH`) | anyone at `TEAM_DOMAINS`, plus `TEAM_EMAILS`, plus the leader | read and search the library; no write tools at all | the reader |
| leader (`LEADER_PATH`) | only `LEADER_EMAILS` | read and write the library, `private/` and `answers/` | the writer |
| `/evalbot` (`EVALBOT_PATH`) | only `LEADER_EMAILS` | read the library, read and write `private/`; never `answers/` | the eval bot |

The Drive code is the plugin's own (`../connector/src/library.js`, `backends/split.js`,
`backends/drive.js`), unchanged. The Worker passes it a small fetch-and-WebCrypto Google client
(`src/google-client.ts`) in place of google-auth-library.

## How sign-in works

- Sign-in runs on the OAuth library's own consent and upstream helpers (`src/access-handler.ts`).
  Every step is bound to the browser that started it with a `__Host-` cookie, so a sign-in one
  person starts can't be finished by anyone else's browser, and each step works once.
- The consent page names the app asking, the connection it's asking for (team, leader or eval
  bot, in plain words) and, in large type, where access will be sent. It can't be framed.
- **Only Claude's own sign-in return addresses can register** (`ALLOWED_REDIRECTS`, defaulting to
  claude.ai and claude.com, plus a loopback address for apps on the person's own computer, which
  the consent page warns about). Anything else is refused before it's stored.
- People sign in through **Cloudflare Access** (an "Access for SaaS" OIDC app), with whatever
  login methods that Access account has (Google, emailed code). The Worker never sees a password.
  Access's ID token is checked in full: RS256 signature against Access's keys (cached five
  minutes), issuer, audience, expiry, nonce, and exactly one well-formed email.
- **Each address is its own OAuth resource.** A token issued for `/team` is refused at the other
  two, so a team member's sign-in can't be replayed against the leader's address.
- **Who may use each address is checked twice:** at sign-in, before any token exists, and on every
  request (`src/index.ts`). An unset list lets nobody in.
- The Access app's own policy is a third gate in front of both: only emails it allows reach the
  Worker at all.
- The address settings are checked at start-up: three different single words, none clashing with
  a sign-in route.

## Setting up a deploy

1. `cp wrangler.example.jsonc wrangler.<deploy>.jsonc` (ignored by git) and fill in the vars.
2. `wrangler kv namespace create OAUTH_KV` and put its id in the config.
3. `wrangler deploy -c wrangler.<deploy>.jsonc`, note the address, set `BASE_URL` to it, deploy again.
4. In Zero Trust: Access controls > Applications > Create new application > SaaS application.
   Choose **OIDC** before adding it (it can't be changed after). Scopes: openid, email, profile.
   Redirect URL: `<BASE_URL>/callback`. Turn on **PKCE** (leave "PKCE without client secret" off).
   Add an Allow policy for the right emails or domain.
5. Secrets, never in a file:
   - `bash scripts/put-secrets.sh wrangler.<deploy>.jsonc keys` copies the three Google keys
     from this Mac's Keychain (the plugin's own items) straight to Cloudflare.
   - `bash scripts/put-secrets.sh wrangler.<deploy>.jsonc access` asks for the Access app's
     client ID, client secret, token, authorization and key endpoints (typing hidden).
     `... one NAME` sets a single one.
6. In Claude: Plugins > Add > Add custom connector, one per address.

Wrangler 4.86+ (the one installed with Homebrew works; the npm one needs Node 22).

## Checks

- `npm run test:live` runs the three roles against a real test library from this Mac (keys read
  from the Keychain into memory, never printed): what each can and can't do, and the sign-in rules.
- `wrangler tail -c wrangler.<deploy>.jsonc` shows each request live.

## Security review

Reviewed 2026-11-23 (independent review, not the author). Fixed in 0.2.0: sign-in not bound to the
browser (the serious one), open client registration, incomplete ID-token checks, error pages that
echoed details, an unused Access token kept in each grant, plus hardening (no-store on sign-in
pages, address checks, one-@ emails, a capped team search, a bad key no longer cached, the secrets
script stopping cleanly on a missing Keychain item). Held from the start: the walls between the
three addresses, the eval bot's blindness to answers/, and no key or secret logged or returned.

Still open, as design choices: the eval bot can read and write anywhere under `private/`, not only
a folder of its own; `observability` stays off in production deploys, since request logs record
sign-in URLs (single-use codes, low risk).

## Credit

The first version started from Cloudflare's
[remote-mcp-cf-access](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-cf-access)
demo (commit 34a8f4c), MIT licensed; the licence is in `src/LICENSE-cloudflare-starter`. Version
0.2.0 replaced its sign-in code with the OAuth library's own helpers.
