// Sign-in: the consent page, the hand-off to Cloudflare Access, and Access's return trip.
//
// Built on the OAuth library's own consent and upstream helpers (beginConsent / approveConsent /
// beginUpstream / finishUpstream), which bind every step to the browser that started it with a
// __Host- cookie. That closes the hole the first version had (inherited from Cloudflare's older
// demo): a sign-in started by one person could be finished by another person's browser.
//
// The Access ID token is checked in full: signature against Access's keys (RS256 only), issuer,
// audience, expiry, nonce, and a single well-formed email. Who may use the requested address is
// checked before any token is issued, and again on every request (index.ts).

import { AuthorizationError, authorizationErrorRedirect, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { authServer } from "./index";
import { baseUrl, mayUse, roleForResource, type RoleName } from "./roles";

const oauthApi = (env: Env): OAuthHelpers => authServer(env).getOAuthApi(env);

const ROLE_TEXT: Record<RoleName, string> = {
  team: "the team library, read only",
  leader: "the leader's library: read and write, including private files and eval answers",
  evalbot: "the eval bot: read the library and save its own notes under private/, never the answers",
};

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const NO_STORE = { "Cache-Control": "no-store" };

function text(body: string, status: number) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE } });
}

function redirect(location: string, headers: Headers = new Headers()) {
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers });
}

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s: string) => {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const s256 = async (verifier: string) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

function consentPage(details: { clientName: string; redirectHost: string; redirectIsLoopback: boolean }, role: RoleName, handle: string, libraryName: string) {
  const name = escape(details.clientName);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${escape(libraryName)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f7f7f5; color: #1a1a1a; margin: 0; padding: 32px 16px; }
  main { max-width: 480px; margin: 0 auto; background: #fff; border: 1px solid #d9d9d4; border-radius: 12px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  p { font-size: 15px; line-height: 1.5; margin: 0 0 12px; }
  .where { font-size: 18px; font-weight: 700; }
  .warn { background: #fff4e0; border: 1px solid #c77700; border-radius: 8px; padding: 10px 12px; }
  button { font-size: 15px; padding: 10px 18px; border-radius: 8px; border: 1px solid #1a1a1a; cursor: pointer; margin-right: 8px; }
  .allow { background: #1a1a1a; color: #fff; }
  .deny { background: #fff; color: #1a1a1a; }
</style></head>
<body><main>
<h1>Allow ${name} to connect to ${escape(libraryName)}?</h1>
<p>This connection is to ${escape(ROLE_TEXT[role])}.</p>
<p>Access will be sent to:</p>
<p class="where">${escape(details.redirectHost)}</p>
${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your own computer. Continue only if you just started connecting from it.</p>' : ""}
<p>You'll sign in next, and only accounts allowed on this connection get in.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <button class="allow" name="decision" value="approve">Allow</button>
  <button class="deny" name="decision" value="deny">Deny</button>
</form>
</main></body></html>`;
}

export async function handleAccessRequest(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);
  try {
    if (request.method === "GET" && pathname === "/authorize") return await showConsent(request, env);
    if (request.method === "POST" && pathname === "/authorize") return await afterConsent(request, env);
    if (request.method === "GET" && pathname === "/callback") return await afterAccess(request, env, searchParams);
    return text("Not found", 404);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo) return redirect(error.redirectTo);
      return text(`This sign-in couldn't be used: ${error.description ?? "the request wasn't valid"}. Start again from Claude.`, 400);
    }
    // Log the kind of failure on the server, never request bodies or tokens; tell the browser nothing more.
    console.error("sign-in error:", (error as Error)?.name, (error as Error)?.message);
    return text("Something went wrong signing in. Start again from Claude.", 500);
  }
}

async function showConsent(request: Request, env: Env) {
  const oauth = oauthApi(env);
  const authRequest = await oauth.parseAuthRequest(request);
  const role = roleForResource(env, authRequest.resource);
  if (!role) return text("This sign-in request doesn't name one of this connector's addresses.", 400);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  consent.headers.set("Cache-Control", "no-store");
  return new Response(consentPage(details, role, consent.handle, env.LIBRARY_NAME ?? "the library"), { headers: consent.headers });
}

async function afterConsent(request: Request, env: Env) {
  const oauth = oauthApi(env);
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return redirect(denied.redirectTo, denied.headers);
  }
  const approved = await oauth.approveConsent(request, handle);
  const verifier = randomToken();
  const nonce = randomToken();
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier, nonce }, headers: approved.headers });
  const upstream = new URL(env.ACCESS_AUTHORIZATION_URL);
  upstream.search = new URLSearchParams({
    response_type: "code",
    client_id: env.ACCESS_CLIENT_ID,
    redirect_uri: `${baseUrl(env)}/callback`,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
  }).toString();
  return redirect(upstream.href, headers);
}

async function afterAccess(request: Request, env: Env, params: URLSearchParams) {
  const oauth = oauthApi(env);
  // Refused unless this browser holds the cookie that started this exact sign-in.
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string; nonce: string }>(request);

  if (params.get("error") || !params.get("code")) {
    return redirect(authorizationErrorRedirect(original, "access_denied"), headers);
  }

  const res = await fetch(env.ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.get("code")!,
      redirect_uri: `${baseUrl(env)}/callback`,
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
      code_verifier: data.verifier,
    }),
  });
  if (!res.ok) {
    console.error("Access token exchange failed with status", res.status);
    return text("Cloudflare Access didn't complete the sign-in. Start again from Claude.", 502);
  }
  const body = (await res.json().catch(() => ({}))) as { id_token?: string };
  if (!body.id_token) return text("Cloudflare Access didn't return a sign-in. Start again from Claude.", 502);

  const claims = await verifyIdToken(env, body.id_token, data.nonce);
  if (!claims) return text("The sign-in from Cloudflare Access couldn't be verified. Start again from Claude.", 401);

  const role = roleForResource(env, original.resource);
  if (!role || !mayUse(env, role, claims.email)) {
    return text(`Signed in as ${claims.email}, which isn't allowed on this address. If that's the wrong account, sign out of it and try again.`, 403);
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: claims.sub,
    metadata: { label: claims.email },
    scope: original.scope,
    props: { email: claims.email, name: claims.name ?? "", login: claims.sub },
  });
  return redirect(redirectTo, headers);
}

// Access's public keys, kept for five minutes so a sign-in doesn't fetch them every time.
let jwksCache: { url: string; keys: (JsonWebKey & { kid?: string })[]; at: number } | undefined;

async function accessKeys(env: Env, refresh = false) {
  if (!refresh && jwksCache && jwksCache.url === env.ACCESS_JWKS_URL && Date.now() - jwksCache.at < 300_000) return jwksCache.keys;
  const res = await fetch(env.ACCESS_JWKS_URL);
  if (!res.ok) throw new Error(`Access keys fetch failed (${res.status})`);
  const json = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  if (!Array.isArray(json.keys)) throw new Error("Access keys response had no keys");
  jwksCache = { url: env.ACCESS_JWKS_URL, keys: json.keys, at: Date.now() };
  return json.keys;
}

// The issuer Access signs into its ID tokens for this app. Set ACCESS_ISSUER to override; by
// default it's the token endpoint without its final "/token", which is how Access names it.
const expectedIssuer = (env: Env) => (env.ACCESS_ISSUER ?? env.ACCESS_TOKEN_URL.replace(/\/token\/?$/, "")).replace(/\/+$/, "");

type Claims = { email: string; sub: string; name?: string };

async function verifyIdToken(env: Env, token: string, nonce: string): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: any, claims: any;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  let jwk = (await accessKeys(env)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await accessKeys(env, true)).find((k) => k.kid === header.kid); // keys may have rotated
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  const skew = 60;
  const iss = typeof claims.iss === "string" ? claims.iss.replace(/\/+$/, "") : "";
  if (iss !== expectedIssuer(env)) {
    console.error("ID token issuer didn't match the expected issuer:", iss);
    return null;
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_CLIENT_ID)) return null;
  if (typeof claims.exp !== "number" || claims.exp + skew < now) return null;
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - skew > now)) return null;
  if (claims.nonce !== undefined && claims.nonce !== nonce) return null;
  if (claims.email_verified === false) return null;
  if (typeof claims.email !== "string" || (claims.email.match(/@/g) ?? []).length !== 1) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  return { email: claims.email.trim().toLowerCase(), sub: claims.sub, name: typeof claims.name === "string" ? claims.name : undefined };
}
