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
  if (!e || !e.includes("@")) return false;
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
