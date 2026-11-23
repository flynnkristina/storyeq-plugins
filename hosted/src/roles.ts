// The three addresses one deploy serves, and who may use each.
//
//   team     read-only library, library-reader's key. Anyone at the team's domains (or named).
//   leader   read and write the library, the private drive and the answers drive,
//            library-writer's key. Only the leader's own email(s).
//   evalbot  read the library, read and write private/ only, never answers/,
//            library-evalbot's key. Only the leader's own email(s): the bot's scheduled task
//            runs on the leader's account and keeps only this connector.
//
// The path for each is set per deploy (vars TEAM_PATH, LEADER_PATH, EVALBOT_PATH), so no
// person's name lives in this repo. Who may sign in is set per deploy too (LEADER_EMAILS,
// TEAM_DOMAINS, TEAM_EMAILS), and checked twice: once at sign-in, before a token is issued,
// and again on every request.

import { createLibrary } from "../../connector/src/library.js";
import { SplitBackend } from "../../connector/src/backends/split.js";
import { DriveBackend } from "../../connector/src/backends/drive.js";
import { ServiceAccountClient, parseKey } from "./google-client";

export type RoleName = "team" | "leader" | "evalbot";

// What a sign-in stores with each grant (encrypted by the OAuth library). Nothing else is kept.
export type Props = { email: string; name: string; login: string };

const SCOPE_WRITE = "https://www.googleapis.com/auth/drive";
const SCOPE_READ = "https://www.googleapis.com/auth/drive.readonly";

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const clean = (p: string | undefined, fallback: string) => {
  const s = (p ?? fallback).trim().replace(/\/+$/, "");
  return s.startsWith("/") ? s : `/${s}`;
};

export function paths(env: Env): Record<RoleName, string> {
  return {
    team: clean(env.TEAM_PATH, "/team"),
    leader: clean(env.LEADER_PATH, "/leader"),
    evalbot: clean(env.EVALBOT_PATH, "/evalbot"),
  };
}

const RESERVED = ["/authorize", "/callback", "/token", "/register", "/.well-known"];

// Refuses a deploy whose address settings could overlap each other or a sign-in route, so one
// address can never pick up another's traffic.
export function checkPaths(env: Env) {
  const all = Object.values(paths(env));
  for (const p of all) {
    if (p === "/" || !/^\/[a-z0-9-]+$/.test(p)) throw new Error(`Address "${p}" must be one lowercase word, like /team.`);
    if (RESERVED.some((r) => p === r || p.startsWith(`${r}/`) || r.startsWith(p))) throw new Error(`Address "${p}" clashes with a sign-in route.`);
  }
  if (new Set(all).size !== all.length) throw new Error("The three addresses must be different.");
}

// Sign-in return addresses a client may register. Claude's own by default; set ALLOWED_REDIRECTS
// (comma-separated, exact) to change them. A loopback address on any port is allowed for apps on
// the person's own computer, and the consent page warns when one is used.
const DEFAULT_REDIRECTS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
export function allowedRedirect(env: Env, uri: string) {
  const exact = list(env.ALLOWED_REDIRECTS).length ? (env.ALLOWED_REDIRECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_REDIRECTS;
  if (exact.includes(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function baseUrl(env: Env) {
  const u = (env.BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!u) throw new Error("BASE_URL isn't set on this deploy.");
  return u;
}

export function resourceFor(env: Env, role: RoleName) {
  return `${baseUrl(env)}${paths(env)[role]}`;
}

export function roleForResource(env: Env, resource: string | undefined): RoleName | null {
  if (!resource) return null;
  for (const role of ["team", "leader", "evalbot"] as RoleName[]) if (resourceFor(env, role) === resource) return role;
  return null;
}

// Whether this person may use this address. Fails closed: an unset list lets nobody in.
export function mayUse(env: Env, role: RoleName, email: string | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (!e || (e.match(/@/g) ?? []).length !== 1) return false;
  const leaders = list(env.LEADER_EMAILS);
  if (role === "leader" || role === "evalbot") return leaders.includes(e);
  const domain = e.split("@").pop()!;
  return leaders.includes(e) || list(env.TEAM_EMAILS).includes(e) || list(env.TEAM_DOMAINS).includes(domain);
}

const cache = new Map<RoleName, ReturnType<typeof createLibrary>>();

// The library for one address. Built once per Worker instance and reused, so the Google
// sign-in and the folder lookups are not repeated on every request.
export function libraryFor(env: Env, role: RoleName) {
  const hit = cache.get(role);
  if (hit) return hit;

  const drive = (id: string | undefined, key: string | undefined, label: string, readOnly: boolean) => {
    if (!id) return null;
    const client = new ServiceAccountClient(parseKey(key, label), readOnly ? SCOPE_READ : SCOPE_WRITE);
    return new DriveBackend({ driveId: id, client, readOnly });
  };

  let backend;
  let libRole: "reader" | "writer" | "evalbot";
  if (role === "team") {
    libRole = "reader";
    backend = new SplitBackend({
      main: drive(env.MAIN_DRIVE_ID, env.READER_KEY, "reader", true),
      unavailable: "Private files are open only to the leader. This connection can't see them.",
      reserveAnswers: false,
    });
  } else if (role === "leader") {
    libRole = "writer";
    // One writer key for all three drives, as on the leader's Mac.
    backend = new SplitBackend({
      main: drive(env.MAIN_DRIVE_ID, env.WRITER_KEY, "writer", false),
      privateBackend: drive(env.PRIVATE_DRIVE_ID, env.WRITER_KEY, "writer", false),
      answersBackend: drive(env.ANSWERS_DRIVE_ID, env.WRITER_KEY, "writer", false),
      unavailable: "The private drive isn't set on this deploy, so nothing under private/ can be read or written, and nothing was saved anywhere else.",
      answersUnavailable: "The answers drive isn't set on this deploy, so nothing under answers/ can be read or written, and nothing was saved anywhere else.",
      reserveAnswers: true,
    });
  } else {
    libRole = "evalbot";
    // The bot is never given the answers drive: no backend for it here, and its Google
    // account is not a member of that drive either.
    backend = new SplitBackend({
      main: drive(env.MAIN_DRIVE_ID, env.EVALBOT_KEY, "eval bot", true),
      privateBackend: drive(env.PRIVATE_DRIVE_ID, env.EVALBOT_KEY, "eval bot", false),
      answersBackend: null,
      unavailable: "The private drive isn't set on this deploy, so the eval bot can't read or save its guesses.",
      answersUnavailable: "The eval bot never opens answers/.",
      reserveAnswers: true,
    });
  }
  const lib = createLibrary({ backend, role: libRole });
  cache.set(role, lib);
  return lib;
}
