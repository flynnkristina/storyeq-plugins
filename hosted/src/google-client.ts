// A small stand-in for google-auth-library's client, built on fetch and WebCrypto so it runs in
// a Worker. It signs a service-account JWT, swaps it for an access token, and answers
// `request(opts)` in the shape ../../connector/src/backends/drive.js expects:
// `{ data }` on success, and an error carrying `response.status` / `response.data` on failure.
//
// The service-account key arrives as a Worker secret (the JSON Google gives you). It is parsed
// here and never logged, returned or written anywhere.

const TOKEN_URL = "https://oauth2.googleapis.com/token";

type ServiceAccountKey = { client_email: string; private_key: string; token_uri?: string };

type RequestOptions = {
  url: string;
  method?: string;
  params?: Record<string, unknown>;
  data?: unknown;
  headers?: Record<string, string>;
  responseType?: "text" | "json";
};

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlText = (text: string) => b64url(new TextEncoder().encode(text));

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

export function parseKey(secret: string | undefined, label: string): ServiceAccountKey {
  if (!secret) throw new Error(`The ${label} key isn't set on this deploy.`);
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(secret);
  } catch {
    throw new Error(`The ${label} key on this deploy isn't valid JSON.`);
  }
  if (!key.client_email || !key.private_key) throw new Error(`The ${label} key on this deploy is missing its account or private key.`);
  return key;
}

function query(params: Record<string, unknown> = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

class HttpError extends Error {
  response: { status: number; data: unknown };
  constructor(status: number, data: unknown) {
    const msg = (data as any)?.error?.message ?? (typeof data === "string" ? data : `HTTP ${status}`);
    super(msg);
    this.response = { status, data };
  }
}

export class ServiceAccountClient {
  #key: ServiceAccountKey;
  #scope: string;
  #token?: { value: string; expiresAt: number };
  #signer?: Promise<CryptoKey>;

  constructor(key: ServiceAccountKey, scope: string) {
    this.#key = key;
    this.#scope = scope;
  }

  get account() {
    return this.#key.client_email;
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt - 60_000 > Date.now()) return this.#token.value;
    this.#signer ??= crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8(this.#key.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const now = Math.floor(Date.now() / 1000);
    const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64urlText(
      JSON.stringify({ iss: this.#key.client_email, scope: this.#scope, aud: this.#key.token_uri ?? TOKEN_URL, iat: now, exp: now + 3600 }),
    );
    const unsigned = `${header}.${claims}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await this.#signer, new TextEncoder().encode(unsigned));
    const res = await fetch(this.#key.token_uri ?? TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      // Google's error text, never the key or the assertion.
      throw new Error(`Google refused the service account sign-in (${data.error_description ?? data.error ?? res.status}).`);
    }
    this.#token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return this.#token.value;
  }

  async request(opts: RequestOptions): Promise<{ data: any }> {
    const token = await this.#accessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) };
    let body: BodyInit | undefined;
    if (opts.data !== undefined) {
      if (typeof opts.data === "string") body = opts.data;
      else {
        body = JSON.stringify(opts.data);
        headers["Content-Type"] ??= "application/json";
      }
    }
    const res = await fetch(opts.url + query(opts.params), { method: opts.method ?? "GET", headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    if (opts.responseType !== "text") {
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      let errData: unknown = parsed;
      if (typeof errData === "string") {
        try {
          errData = JSON.parse(errData);
        } catch {}
      }
      throw new HttpError(res.status, errData);
    }
    return { data: parsed };
  }
}
