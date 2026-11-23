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

- Cloudflare's `remote-mcp-cf-access` starter (`src/access-handler.ts`,
  `src/workers-oauth-utils.ts`), changed in three places: it uses the
  three-address server, it checks the person may use the address they asked for **before** a
  token is issued, and it answers a malformed request with a plain 400.
- People sign in through **Cloudflare Access** (an "Access for SaaS" OIDC app), with whatever
  login methods that Access account has (Google, emailed code). The Worker never sees a password.
- **Each address is its own OAuth resource.** A token issued for `/team` is refused at the other
  two, so a team member's sign-in can't be replayed against the leader's address.
- **Who may use each address is checked twice:** at sign-in (`access-handler.ts`, `/callback`) and
  on every request (`src/index.ts`). An unset list lets nobody in.
- The Access app's own policy is a third gate in front of both: only emails it allows reach the
  Worker at all.

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
     client ID, client secret, token, authorization and key endpoints (typing hidden), and makes
     the cookie key itself. `... one NAME` sets a single one.
6. In Claude: Plugins > Add > Add custom connector, one per address.

Wrangler 4.86+ (the one installed with Homebrew works; the npm one needs Node 22).

## Checks

- `npm run test:live` runs the three roles against a real test library from this Mac (keys read
  from the Keychain into memory, never printed): what each can and can't do, and the sign-in rules.
- `wrangler tail -c wrangler.<deploy>.jsonc` shows each request live.

## Before it holds a client's keys

Both Cloudflare starters say they are demos and need a security review before production. Things
to look at, beyond the starter itself: the `mayUse` rules in `src/roles.ts`; that every address's
token audience is enforced (`OAuthResourceServer`); the consent cookie and CSRF handling in
`src/workers-oauth-utils.ts`; that no key, token or client secret is ever logged or returned
(`src/google-client.ts`); and who can register OAuth clients (`/register` is open, as MCP clients
need it).

## Credit

`src/access-handler.ts` and `src/workers-oauth-utils.ts` start from Cloudflare's
[remote-mcp-cf-access](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-cf-access)
demo (commit 34a8f4c), MIT licensed; the licence is in `src/LICENSE-cloudflare-starter`.
