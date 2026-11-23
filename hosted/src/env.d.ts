// What each deploy sets. Plain settings go in the deploy's wrangler config ("vars"); keys and
// sign-in secrets go in with `wrangler secret put` and are never written to any file.
interface Env {
  OAUTH_KV: KVNamespace;

  // Settings (vars)
  BASE_URL: string; // e.g. https://library.example.workers.dev
  LIBRARY_NAME?: string;
  TEAM_PATH?: string;
  LEADER_PATH?: string;
  EVALBOT_PATH?: string;
  LEADER_EMAILS: string; // comma-separated
  TEAM_DOMAINS?: string; // comma-separated, e.g. example.com
  TEAM_EMAILS?: string; // comma-separated, people outside the domain
  MAIN_DRIVE_ID: string;
  PRIVATE_DRIVE_ID?: string;
  ANSWERS_DRIVE_ID?: string;

  // Secrets
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_TOKEN_URL: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_JWKS_URL: string;
  COOKIE_ENCRYPTION_KEY: string;
  READER_KEY?: string;
  WRITER_KEY?: string;
  EVALBOT_KEY?: string;
}
