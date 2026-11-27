// What each deploy sets. Plain settings go in the deploy's wrangler config ("vars"); keys and
// sign-in secrets go in with `wrangler secret put` and are never written to any file.
interface Env {
  OAUTH_KV: KVNamespace;

  // Settings (vars)
  BASE_URL: string; // e.g. https://library.example.workers.dev
  LIBRARY_NAME?: string;
  LEADER_NAME?: string; // used in the instructions each address sends Claude
  TEAM_PATH?: string;
  LEADER_PATH?: string;
  EVALBOT_PATH?: string;
  LEADER_EMAILS: string; // comma-separated
  TEAM_DOMAINS?: string; // comma-separated, e.g. example.com
  TEAM_EMAILS?: string; // comma-separated, people outside the domain
  MAIN_DRIVE_ID: string;
  PRIVATE_DRIVE_ID?: string;
  ANSWERS_DRIVE_ID?: string;
  ACCESS_ISSUER?: string; // only if Access's issuer isn't the token endpoint minus "/token"
  ALLOWED_REDIRECTS?: string; // comma-separated; defaults to Claude's own sign-in addresses
  NOTES_FOLDER?: string; // where team notes go inside the private drive; default inbox/team

  // Secrets
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_TOKEN_URL: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_JWKS_URL: string;
  COOKIE_ENCRYPTION_KEY?: string; // no longer used (sign-in cookies are the OAuth library's own); harmless if set
  READER_KEY?: string;
  WRITER_KEY?: string;
  EVALBOT_KEY?: string;
  NOTES_KEY?: string; // optional key for team notes (private drive only); falls back to EVALBOT_KEY
}
