// The connect steps run end to end, offline: connect, connectEvalBot and connectAnswers go
// through their real code with Google and the Keychain faked underneath them.
//
// - Google: GoogleAuth.prototype.getClient is swapped for a fake client that answers from an
//   in-memory "world" of accounts and Shared Drives. setup.js and DriveBackend both build their
//   clients through it, so no production seam is needed.
// - Keychain: child_process.spawn is swapped (and synced into ESM bindings) so every call to
//   /usr/bin/security lands in an in-memory store. The real `security` tool is never run from
//   this file, so no real Keychain item can be read, written or deleted.
// - HOME points at a temp folder, so the key-copy sweep never looks in the real Downloads.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readConfig } from "../src/config.js";
import { connect, connectEvalBot, connectAnswers, credentialsFor, evalbotAccount } from "../src/setup.js";
import { SERVICE } from "../src/keychain.js";
import { libraryLoader } from "../src/server.js";

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/server.js");

// ---------- fake Keychain ----------

const keychain = new Map(); // `${service}\0${account}` -> base64 secret
const slot = (service, account) => `${service}\u0000${account}`;
const realSpawn = cp.spawn;

function security(args, input) {
  if (args[0] === "-i") {
    const m = /^add-generic-password -U -s "([^"]*)" -a "([^"]*)" -l "[^"]*" -w (\S+)\n$/.exec(input);
    if (!m) return { code: 1, err: `fake security: unexpected input ${JSON.stringify(input.slice(0, 40))}` };
    keychain.set(slot(m[1], m[2]), m[3]);
    return { code: 0 };
  }
  const opt = (flag) => args[args.indexOf(flag) + 1];
  const key = slot(opt("-s"), opt("-a"));
  if (args[0] === "find-generic-password") return keychain.has(key) ? { code: 0, out: `${keychain.get(key)}\n` } : { code: 44 };
  if (args[0] === "delete-generic-password") return keychain.delete(key) ? { code: 0 } : { code: 44 };
  return { code: 1, err: `fake security: unexpected ${args[0]}` };
}

function fakeSpawn(cmd, args, opts) {
  if (cmd !== "/usr/bin/security") return realSpawn(cmd, args, opts);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    end: (input) => setImmediate(() => {
      const r = security(args, String(input ?? ""));
      if (r.out) child.stdout.emit("data", r.out);
      if (r.err) child.stderr.emit("data", r.err);
      child.emit("close", r.code);
    }),
  };
  return child;
}

const stored = (account, service = SERVICE) => {
  const v = keychain.get(slot(service, account));
  return v ? JSON.parse(Buffer.from(v, "base64").toString("utf8")) : null;
};

// ---------- fake Google ----------

// accounts: email -> { sees: [drive] (what /drives lists), opens: [driveId] (what files.list allows) }
let accounts = {};
const realGetClient = GoogleAuth.prototype.getClient;

function fakeClient(email) {
  return {
    request: async ({ url, params = {} }) => {
      const acct = accounts[email];
      if (!acct) throw Object.assign(new Error("invalid_grant"), { response: { status: 401, data: { error: { message: "unknown account" } } } });
      if (url.endsWith("/drives")) return { data: { drives: acct.sees } };
      if (url.endsWith("/files")) {
        if (!acct.opens.includes(params.driveId)) {
          throw Object.assign(new Error("not found"), { response: { status: 404, data: { error: { message: `Shared drive not found: ${params.driveId}` } } } });
        }
        return { data: { files: [{ id: `${params.driveId}-top`, name: "top.md", mimeType: "text/markdown" }] } };
      }
      throw new Error(`fake Google: unexpected request ${url}`);
    },
  };
}

const L = { id: "L", name: "Team Library" };
const P = { id: "P", name: "Team Library Private" };
const A = { id: "A", name: "Team Eval Answers" };
const WRITER = "library-writer@p.iam.gserviceaccount.com";
const BOT = "library-evalbot@p.iam.gserviceaccount.com";
const can = (sees, opens = sees.map((d) => d.id)) => ({ sees, opens });

before(() => {
  cp.spawn = fakeSpawn;
  syncBuiltinESMExports();
  GoogleAuth.prototype.getClient = async function () {
    return fakeClient(this.jsonContent?.client_email);
  };
});

after(() => {
  cp.spawn = realSpawn;
  syncBuiltinESMExports();
  GoogleAuth.prototype.getClient = realGetClient;
});

// ---------- sandbox ----------

const realHome = process.env.HOME;
let home;
let env;

const fakeKey = (email, id) => JSON.stringify({ type: "service_account", client_email: email, project_id: "p", private_key_id: id, private_key: `-----BEGIN PRIVATE KEY-----\nfake-${id}\n-----END PRIVATE KEY-----\n` });

async function keyFile(name, email, id) {
  const file = path.join(home, "Downloads", name);
  await writeFile(file, fakeKey(email, id));
  return file;
}

beforeEach(async () => {
  keychain.clear();
  accounts = {};
  home = await mkdtemp(path.join(tmpdir(), "connsteps-"));
  await mkdir(path.join(home, "Downloads"), { recursive: true });
  process.env.HOME = home;
  env = { LIBRARY_CONFIG_DIR: path.join(home, "cfg"), LIBRARY_PLUGIN: "connsteps" };
});

after(async () => {
  process.env.HOME = realHome;
});

// Sets up the person's own writer library through the real connect().
async function connectWriter(drives) {
  accounts[WRITER] = can(drives);
  const file = await keyFile("writer.json", WRITER, "writer-id");
  const r = await connect({ keyFile: file, env });
  assert.equal(r.connected, true);
  return file;
}

async function connectBot(botAccess) {
  accounts[BOT] = botAccess;
  const file = await keyFile("bot.json", BOT, "bot-id");
  return { file, result: await connectEvalBot({ keyFile: file, env }) };
}

// ---------- connect (the writer) ----------

test("connect: the writer's key goes into its own Keychain item and the file copy is deleted", async () => {
  const file = await connectWriter([L, P, A]);
  const s = await readConfig(env);
  assert.equal(s.role, "writer");
  assert.equal(s.driveId, "L");
  assert.equal(s.privateDriveId, "P");
  assert.equal(s.answersDriveId, "A");
  assert.equal(stored("connsteps").private_key_id, "writer-id");
  assert.equal(existsSync(file), false, "the downloaded key file was deleted");
  assert.equal((await credentialsFor(s, env)).private_key_id, "writer-id");
});

// ---------- connectEvalBot ----------

test("connectEvalBot: succeeds, and leaves the writer's key and settings exactly as they were", async () => {
  await connectWriter([L, P, A]);
  const mine = await readConfig(env);
  const { file, result } = await connectBot(can([L, P]));
  assert.equal(result.connected, true);
  assert.equal(result.yourOwnKey, "unchanged");

  // The writer's own settings file and Keychain item are untouched.
  assert.deepEqual(await readConfig(env), mine, "library.json is unchanged");
  assert.equal(stored("connsteps").private_key_id, "writer-id", "the writer's Keychain item is still the writer's key");
  assert.equal((await credentialsFor(mine, env)).private_key_id, "writer-id");

  // The bot's settings are their own file, naming the bot's own Keychain item.
  const bot = await readConfig(env, "evalbot");
  assert.equal(bot.role, "evalbot");
  assert.equal(bot.account, BOT);
  assert.equal(bot.keychainAccount, evalbotAccount(env));
  assert.notEqual(bot.keychainAccount, "connsteps");
  assert.equal(result.settingsFile, path.join(env.LIBRARY_CONFIG_DIR, "evalbot.json"));
  assert.equal(stored(evalbotAccount(env)).private_key_id, "bot-id");
  assert.equal((await credentialsFor(bot, env)).private_key_id, "bot-id");
  assert.deepEqual([...keychain.keys()].sort(), [slot(SERVICE, "connsteps"), slot(SERVICE, "connsteps:evalbot")]);
  assert.equal(existsSync(file), false, "the bot's downloaded key file was deleted");
});

test("connectEvalBot: refused when Google lets the bot open the answers drive, even if its drive list hides it", async () => {
  await connectWriter([L, P, A]);
  const mine = await readConfig(env);
  accounts[BOT] = can([L, P], ["L", "P", "A"]);
  await assert.rejects(connectEvalBot({ keyFile: await keyFile("bot.json", BOT, "bot-id"), env }), /Google let the eval bot open "Team Eval Answers"/);
  assert.equal(await readConfig(env, "evalbot"), null, "no eval bot settings written");
  assert.equal(stored(evalbotAccount(env)), null, "the bot's key was never saved");
  assert.equal(stored("connsteps").private_key_id, "writer-id");
  assert.deepEqual(await readConfig(env), mine);
  assert.ok(existsSync(path.join(home, "Downloads/bot.json")), "the bot's key file was left alone");
});

test("connectEvalBot: refused when the bot's drive list shows the answers drive", async () => {
  await connectWriter([L, P, A]);
  accounts[BOT] = can([L, P, A]);
  await assert.rejects(connectEvalBot({ keyFile: await keyFile("bot.json", BOT, "bot-id"), env }), /could read the real answers/);
  assert.equal(await readConfig(env, "evalbot"), null);
  assert.equal(stored(evalbotAccount(env)), null);
});

// ---------- connectAnswers ----------

test("connectAnswers: with no eval bot, connects the answers drive", async () => {
  await connectWriter([L, P]);
  assert.equal((await readConfig(env)).answersDriveId, undefined);
  accounts[WRITER] = can([L, P, A]);
  const r = await connectAnswers({ env });
  assert.equal(r.connected, true);
  assert.equal(r.answersDrive, "Team Eval Answers");
  const s = await readConfig(env);
  assert.equal(s.answersDriveId, "A");
  assert.equal(s.privateDriveId, "P");
});

test("connectAnswers: with an eval bot that is kept out, connects the answers drive", async () => {
  await connectWriter([L, P]);
  await connectBot(can([L, P]));
  accounts[WRITER] = can([L, P, A]);
  const r = await connectAnswers({ env });
  assert.equal(r.connected, true);
  assert.equal((await readConfig(env)).answersDriveId, "A");
});

test("connectAnswers: refused when the eval bot can open the answers drive", async () => {
  await connectWriter([L, P]);
  await connectBot(can([L, P]));
  accounts[WRITER] = can([L, P, A]);
  accounts[BOT] = can([L, P], ["L", "P", "A"]);
  await assert.rejects(connectAnswers({ env }), /can open "Team Eval Answers"/);
  assert.equal((await readConfig(env)).answersDriveId, undefined, "nothing was changed");
});

test("connectAnswers: refused, fails closed, when the eval bot's key can't be read", async () => {
  await connectWriter([L, P]);
  await connectBot(can([L, P]));
  keychain.delete(slot(SERVICE, evalbotAccount(env)));
  accounts[WRITER] = can([L, P, A]);
  await assert.rejects(connectAnswers({ env }), /its key can't be read/);
  assert.equal((await readConfig(env)).answersDriveId, undefined, "nothing was changed");
  assert.equal(stored("connsteps").private_key_id, "writer-id");
});

// ---------- the server's own wiring ----------

async function mainWithOldAnswers() {
  const main = await mkdtemp(path.join(tmpdir(), "main-"));
  await mkdir(path.join(main, "answers"), { recursive: true });
  await writeFile(path.join(main, "answers/old.md"), "an old main-library file\n");
  return main;
}

test("server wiring: the reader's answers/ is a plain main-library path; the writer's is reserved", async () => {
  const main = await mainWithOldAnswers();
  const reader = await libraryLoader({ LIBRARY_BACKEND: "local", LIBRARY_ROLE: "reader", LIBRARY_ROOT: main }).get();
  assert.equal(await reader.read("answers/old.md"), "an old main-library file\n");
  assert.deepEqual((await reader.list()).map((e) => e.path), ["answers"]);
  await assert.rejects(reader.read("private/x.md"), /read-only/);

  const writer = await libraryLoader({ LIBRARY_BACKEND: "local", LIBRARY_ROLE: "writer", LIBRARY_ROOT: main }).get();
  await assert.rejects(writer.read("answers/old.md"), /connect my answers drive/);
  await rm(main, { recursive: true, force: true });
});

test("over MCP: a reader reads answers/ from the main library, exactly as before", async () => {
  const main = await mainWithOldAnswers();
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, HOME: realHome, LIBRARY_BACKEND: "local", LIBRARY_IDENTITY: "", LIBRARY_ROLE: "reader", LIBRARY_ROOT: main } }));
  try {
    const r = await c.callTool({ name: "read_library_file", arguments: { path: "answers/old.md" } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    assert.equal(r.content[0].text, "an old main-library file\n");
  } finally {
    await c.close();
    await rm(main, { recursive: true, force: true });
  }
});
