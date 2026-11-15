// The eval bot (a third account) and the answers drive (a third Shared Drive).
// Design (13-14 Nov): library = writer read/write, reader read, eval bot read.
// Private = writer and eval bot read/write, reader nothing. Answers = writer only, never the bot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createLibrary } from "../src/library.js";
import { LocalFolderBackend } from "../src/backends/local.js";
import { SplitBackend, isAnswersPath } from "../src/backends/split.js";
import { roleFromEmail, identityOf, readConfig, writeConfig, configFile } from "../src/config.js";
import {
  pickMain, pickPrivate, pickAnswers, evalBotDriveProblem, connect, connectEvalBot,
  connectAnswers, writeEvalSessionFile, evalSessionCommand, credentialsFor, evalbotAccount,
} from "../src/setup.js";
import { storeKey, readKeyJson, deleteKey } from "../src/keychain.js";

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/server.js");
const onMac = process.platform === "darwin";

async function threeDrives() {
  const main = await mkdtemp(path.join(tmpdir(), "main-"));
  const priv = await mkdtemp(path.join(tmpdir(), "priv-"));
  const answers = await mkdtemp(path.join(tmpdir(), "answers-"));
  await mkdir(path.join(main, "skills"), { recursive: true });
  await writeFile(path.join(main, "skills/INDEX.md"), "# Skills\n\ncard word here\n");
  await mkdir(path.join(priv, "guesses"), { recursive: true });
  await writeFile(path.join(priv, "guesses/card01.md"), "bot guess: card word yes\n");
  await mkdir(path.join(answers, "cards"), { recursive: true });
  await writeFile(path.join(answers, "cards/card01.md"), "the leader's real answer: card word no\n");
  return { main, priv, answers };
}

const local = (root) => (root ? new LocalFolderBackend(root) : null);
const lib = (role, { main, priv, answers }) =>
  createLibrary({ role, backend: new SplitBackend({ main: local(main), privateBackend: local(priv), answersBackend: local(answers) }) });

// ---------- role detection ----------

test("role: the eval bot is recognised from its account name; writer and reader are unchanged", () => {
  assert.equal(roleFromEmail("library-evalbot@p.iam.gserviceaccount.com"), "evalbot");
  assert.equal(roleFromEmail("library-eval-bot@x.iam.gserviceaccount.com"), "evalbot");
  assert.equal(roleFromEmail("Library-EvalBot@x.iam.gserviceaccount.com"), "evalbot");
  assert.equal(roleFromEmail("library-writer@x.iam.gserviceaccount.com"), "writer");
  assert.equal(roleFromEmail("library-reader@x.iam.gserviceaccount.com"), "reader");
  assert.equal(roleFromEmail("evaluation-reader@x.iam.gserviceaccount.com"), "reader");
  assert.equal(roleFromEmail("someone@x.com"), null);
  assert.equal(roleFromEmail("retrieval-bot@x.iam.gserviceaccount.com"), null, "a name merely containing 'evalbot'-like letters doesn't count");
  assert.equal(roleFromEmail("evalbot@x.iam.gserviceaccount.com"), "evalbot");
});

test("identity: only LIBRARY_IDENTITY=evalbot starts the eval bot; anything else is the person's own", () => {
  assert.equal(identityOf({}), "main");
  assert.equal(identityOf({ LIBRARY_IDENTITY: "" }), "main");
  assert.equal(identityOf({ LIBRARY_IDENTITY: "writer" }), "main");
  assert.equal(identityOf({ LIBRARY_IDENTITY: "evalbot" }), "evalbot");
});

test("answers/ is recognised however it's written, and only at the top", () => {
  for (const p of ["answers", "answers/x.md", "./answers/x.md", "Answers/x.md"]) assert.equal(isAnswersPath(p), true, p);
  for (const p of ["", "skills/answers.md", "answersheet/x.md", "x/answers/y.md", "private/answers/x.md"]) assert.equal(isAnswersPath(p), false, p);
});

// ---------- the writer and the answers drive ----------

test("writer: answers/ files go to the answers drive and never the main library", async () => {
  const d = await threeDrives();
  const w = lib("writer", d);
  const r = await w.write("answers/cards/card02.md", "leader: yes");
  assert.equal(r.path, "answers/cards/card02.md");
  assert.equal(r.answers, true);
  assert.equal(await readFile(path.join(d.answers, "cards/card02.md"), "utf8"), "leader: yes");
  assert.equal(existsSync(path.join(d.main, "answers")), false);
  assert.match(await w.read("answers/cards/card01.md"), /real answer/);
  await w.append("answers/log.md", "line one");
  assert.equal(await readFile(path.join(d.answers, "log.md"), "utf8"), "line one");
  assert.deepEqual((await w.list()).map((e) => e.path), ["answers", "private", "skills"]);
  assert.deepEqual((await w.list("answers")).map((e) => e.path).sort(), ["answers/cards", "answers/log.md"]);
});

test("writer with no answers drive: answers/ is refused and nothing is saved anywhere", async () => {
  const d = await threeDrives();
  const w = lib("writer", { ...d, answers: null });
  await assert.rejects(w.write("answers/cards/x.md", "x"), /answers/);
  await assert.rejects(w.append("answers/log.md", "x"), /answers/);
  await assert.rejects(w.read("answers/cards/card01.md"), /answers/);
  await assert.rejects(w.list("answers"), /answers/);
  assert.deepEqual(await readdir(d.main), ["skills"]);
  assert.deepEqual((await w.list()).map((e) => e.path), ["private", "skills"]);
});

test("writer search covers all three drives and labels each hit", async () => {
  const d = await threeDrives();
  const hits = (await lib("writer", d).search("card word")).map((h) => h.path).sort();
  assert.deepEqual(hits, ["answers/cards/card01.md", "private/guesses/card01.md", "skills/INDEX.md"]);
});

// ---------- the eval bot ----------

test("eval bot: reads the library, reads and writes private, never changes the library", async () => {
  const d = await threeDrives();
  const bot = lib("evalbot", { ...d, answers: null });
  assert.match(await bot.read("skills/INDEX.md"), /Skills/);
  assert.match(await bot.read("private/guesses/card01.md"), /bot guess/);
  await bot.write("private/guesses/card02.md", "guess: yes");
  await bot.append("private/guesses/log.md", "predicted card02");
  await bot.edit("private/guesses/card02.md", "yes", "no");
  assert.equal(await readFile(path.join(d.priv, "guesses/card02.md"), "utf8"), "guess: no");
  await assert.rejects(bot.write("skills/INDEX.md", "changed"), /only save under private/);
  await assert.rejects(bot.append("skills/INDEX.md", "x"), /only save under private/);
  await assert.rejects(bot.edit("skills/INDEX.md", "Skills", "x"), /only save under private/);
  assert.match(await readFile(path.join(d.main, "skills/INDEX.md"), "utf8"), /^# Skills/);
});

test("eval bot: answers/ is refused in code, even if an answers drive were wired to it by mistake", async () => {
  const d = await threeDrives();
  const bot = lib("evalbot", d); // answers backend deliberately wired in: the code must still refuse
  for (const p of ["answers/cards/card01.md", "Answers/cards/card01.md", "./answers/cards/card01.md"]) {
    await assert.rejects(bot.read(p), /never opens answers/, p);
  }
  await assert.rejects(bot.list("answers"), /never opens answers/);
  await assert.rejects(bot.write("answers/cards/card01.md", "x"), /never opens answers/);
  await assert.rejects(bot.append("answers/cards/card01.md", "x"), /never opens answers/);
  await assert.rejects(bot.edit("answers/cards/card01.md", "no", "yes"), /never opens answers/);
  const hits = (await bot.search("card word")).map((h) => h.path);
  assert.ok(!hits.some(isAnswersPath), hits.join(", "));
  assert.equal(await readFile(path.join(d.answers, "cards/card01.md"), "utf8"), "the leader's real answer: card word no\n");
});

test("reader: private/ is closed, and answers/ behaves exactly as before (plain main-library path)", async () => {
  const d = await threeDrives();
  await mkdir(path.join(d.main, "answers"), { recursive: true });
  await writeFile(path.join(d.main, "answers/old.md"), "an old main-library file\n");
  const r = createLibrary({ role: "reader", backend: new SplitBackend({ main: local(d.main), unavailable: "closed private", answersUnavailable: "closed answers", reserveAnswers: false }) });
  await assert.rejects(r.read("private/guesses/card01.md"), /closed private/);
  assert.equal(await r.read("answers/old.md"), "an old main-library file\n");
  assert.deepEqual((await r.list()).map((e) => e.path), ["answers", "skills"]);
  await assert.rejects(r.write("answers/x.md", "x"), /read-only/);
});

// ---------- drive picking with three drives ----------

const team = [
  { id: "L", name: "Team Library" },
  { id: "P", name: "Team Library Private" },
  { id: "A", name: "Team Eval Answers" },
];
const kfn = [
  { id: "k", name: "Kristina Test" },
  { id: "kp", name: "Kristina library private" },
  { id: "ka", name: "Kristina eval answers" },
];

test("drive picking with three drives: library, private and answers each land right", () => {
  for (const drives of [team, kfn, [...team].reverse()]) {
    const main = pickMain(drives);
    const priv = pickPrivate(drives, main.id);
    const ans = pickAnswers(drives, [main.id, priv.id]);
    assert.match(main.name, /Library$|Test$/);
    assert.match(priv.name, /private/i);
    assert.match(ans.name, /answers/i);
  }
});

test("drive picking never guesses: it asks", () => {
  const both = { id: "B", name: "Private answers" };
  const extraAns = { id: "A2", name: "Old answers" };
  const other = { id: "O", name: "Team stuff" };
  assert.equal(pickMain([{ id: "A", name: "Team Eval Answers" }]), null, "a lone answers drive is never the library");
  assert.equal(pickMain([...team, other]), null, "two plain drives: ask");
  assert.equal(pickAnswers([...team, extraAns], ["L", "P"]), null, "two answers drives: ask");
  assert.equal(pickAnswers([team[0], team[1], both], ["L", "P"]), null, "named both ways: ask");
  assert.equal(pickPrivate([team[0], both], "L"), null, "named both ways: ask");
  assert.equal(pickAnswers(team, ["L", "P", "A"]), null, "a drive already in use is never picked");
  assert.equal(pickAnswers([team[0], team[1]], ["L", "P"]), null, "no answers drive: none");
  assert.equal(pickAnswers([...team, extraAns], ["L", "P"], "Old answers"), extraAns, "the one asked for");
  assert.equal(pickAnswers(team, ["L", "P"], "L"), null, "asking for the library as answers is refused");
});

test("drive picking for today's two-drive setups is unchanged", () => {
  assert.equal(pickMain([team[0]]).id, "L");
  assert.equal(pickMain([team[0], team[1]]).id, "L");
  assert.equal(pickPrivate([team[0], team[1]], "L").id, "P");
  assert.equal(pickMain([kfn[0], kfn[1]]).id, "k");
  assert.equal(pickPrivate([kfn[0], kfn[1]], "k").id, "kp");
  assert.equal(pickMain([{ id: "x", name: "Only private" }]).id, "x", "a lone private-named drive still connects as before");
});

test("eval bot's drives: must see library and private, must not see answers", () => {
  const s = { driveId: "L", driveName: "Team Library", privateDriveId: "P", privateDriveName: "Team Library Private", answersDriveId: "A" };
  assert.equal(evalBotDriveProblem([team[0], team[1]], s), null);
  assert.match(evalBotDriveProblem(team, s), /could read the real answers/);
  assert.match(evalBotDriveProblem([team[0], team[1], { id: "Z", name: "Spare answers" }], s), /could read the real answers/);
  assert.match(evalBotDriveProblem([team[0]], s), /Team Library Private" as Content manager/);
  assert.match(evalBotDriveProblem([team[1]], s), /Team Library" as Viewer/);
  assert.equal(evalBotDriveProblem([team[0], team[1]], { ...s, answersDriveId: undefined }), null);
});

// ---------- setup refusals (no Google calls reached) ----------

const fakeKey = (email, id = "kid") => JSON.stringify({ type: "service_account", client_email: email, project_id: "p", private_key_id: id, private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n" });

async function sandbox() {
  const home = await mkdtemp(path.join(tmpdir(), "home-"));
  const env = { LIBRARY_CONFIG_DIR: path.join(home, "cfg"), LIBRARY_PLUGIN: "evaltest" };
  await mkdir(path.join(home, "Downloads"), { recursive: true });
  const bot = path.join(home, "Downloads/bot.json");
  await writeFile(bot, fakeKey("library-evalbot@p.iam.gserviceaccount.com"));
  return { home, env, bot };
}

test("connect_library refuses the eval bot's key, so it can never replace your own", async () => {
  const { env, bot } = await sandbox();
  await assert.rejects(connect({ keyFile: bot, env }), /eval bot's key, not your own/);
  assert.equal(await readConfig(env), null, "no settings written");
  assert.ok(existsSync(bot), "the key file was left alone");
});

test("connect_eval_bot needs your own writer library and private drive first, and the right key", async () => {
  const { home, env, bot } = await sandbox();
  await assert.rejects(connectEvalBot({ keyFile: bot, env }), /Set that up first/);
  await writeConfig({ role: "reader", driveId: "L", driveName: "Team Library" }, env);
  await assert.rejects(connectEvalBot({ keyFile: bot, env }), /Set that up first/);
  await writeConfig({ role: "writer", driveId: "L", driveName: "Team Library" }, env);
  await assert.rejects(connectEvalBot({ keyFile: bot, env }), /connect my private drive/);
  await writeConfig({ role: "writer", driveId: "L", driveName: "Team Library", privateDriveId: "P", privateDriveName: "Team Library Private" }, env);
  const writerKey = path.join(home, "Downloads/w.json");
  await writeFile(writerKey, fakeKey("library-writer@p.iam.gserviceaccount.com"));
  await assert.rejects(connectEvalBot({ keyFile: writerKey, env }), /isn't the eval bot's account/);
  assert.equal(await readConfig(env, "evalbot"), null, "no eval bot settings written");
  assert.ok(existsSync(bot) && existsSync(writerKey), "no key file was touched");
});

test("connect_answers_drive is writer-only", async () => {
  const { env } = await sandbox();
  await assert.rejects(connectAnswers({ env }), /isn't set up/);
  await writeConfig({ role: "reader", driveId: "L" }, env);
  await assert.rejects(connectAnswers({ env }), /Only the library's writer/);
});

test("the eval bot has its own settings file beside yours", async () => {
  const { env } = await sandbox();
  await writeConfig({ role: "writer", driveId: "L" }, env);
  await writeConfig({ role: "evalbot", driveId: "L" }, env, "evalbot");
  assert.match(configFile(env), /library\.json$/);
  assert.match(configFile(env, "evalbot"), /evalbot\.json$/);
  assert.equal((await readConfig(env)).role, "writer");
  assert.equal((await readConfig(env, "evalbot")).role, "evalbot");
});

test("eval session file: starts only the eval bot's connection, from this copy of the connector", async () => {
  const { env } = await sandbox();
  assert.equal(await writeEvalSessionFile(env), null, "no LIBRARY_HOME, nothing written");
  const file = await writeEvalSessionFile({ ...env, LIBRARY_HOME: "/plugins/some-os/1.0.0/connector", LIBRARY_NAME: "Someone's library" });
  const cfg = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(Object.keys(cfg.mcpServers), ["library-evalbot"]);
  const s = cfg.mcpServers["library-evalbot"];
  assert.deepEqual(s.args, ["/plugins/some-os/1.0.0/connector/start.sh"]);
  assert.equal(s.env.LIBRARY_IDENTITY, "evalbot");
  assert.equal(s.env.LIBRARY_PLUGIN, "evaltest");
  assert.ok(!JSON.stringify(cfg).includes("PRIVATE KEY"));
  const cmd = evalSessionCommand(env);
  assert.match(cmd, /--strict-mcp-config --mcp-config \S+eval-session\.mcp\.json/);
  assert.match(cmd, /--disallowedTools Bash "mcp__plugin_evaltest_library__\*"/);
});

// ---------- Keychain: two items, never one replacing the other ----------

const svc = "StoryEQ library key (test)";

test("keychain: your key and the eval bot's are separate items; saving one never replaces the other", { skip: !onMac && "Keychain is Mac-only" }, async () => {
  const env = { LIBRARY_PLUGIN: "evaltest-kc" };
  const mine = fakeKey("library-writer@p.iam.gserviceaccount.com", "writer-id");
  const bots = fakeKey("library-evalbot@p.iam.gserviceaccount.com", "bot-id");
  try {
    await storeKey({ account: "evaltest-kc", keyJson: mine, service: svc });
    await storeKey({ account: evalbotAccount(env), keyJson: bots, service: svc });
    assert.equal(evalbotAccount(env), "evaltest-kc:evalbot");
    const own = await credentialsFor({ keyStore: "keychain", keychainService: svc }, env);
    const bot = await credentialsFor({ keyStore: "keychain", keychainService: svc, keychainAccount: evalbotAccount(env) }, env);
    assert.equal(own.private_key_id, "writer-id", "your own key is still yours");
    assert.equal(bot.private_key_id, "bot-id");
    await deleteKey({ account: evalbotAccount(env), service: svc });
    assert.equal(JSON.parse(await readKeyJson({ account: "evaltest-kc", service: svc })).private_key_id, "writer-id", "removing the bot leaves your key");
  } finally {
    await deleteKey({ account: "evaltest-kc", service: svc });
    await deleteKey({ account: evalbotAccount(env), service: svc });
  }
});

// ---------- over MCP ----------

async function client(env) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LIBRARY_BACKEND: "local", LIBRARY_IDENTITY: "", ...env } }));
  return c;
}
const names = async (c) => (await c.listTools()).tools.map((t) => t.name).sort();

test("over MCP: the eval bot's connection has only library tools, no setup tools", async () => {
  const d = await threeDrives();
  const bot = await client({ LIBRARY_IDENTITY: "evalbot", LIBRARY_ROOT: d.main, LIBRARY_PRIVATE_ROOT: d.priv, LIBRARY_ANSWERS_ROOT: d.answers });
  try {
    assert.deepEqual(await names(bot), ["append_library_file", "edit_library_file", "library_status", "list_library", "read_library_file", "search_library", "write_library_file"]);
    const r = await bot.callTool({ name: "read_library_file", arguments: { path: "answers/cards/card01.md" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /never opens answers/);
    const w = await bot.callTool({ name: "write_library_file", arguments: { path: "private/guesses/c3.md", content: "guess" } });
    assert.ok(!w.isError, w.content?.[0]?.text);
    assert.equal(await readFile(path.join(d.priv, "guesses/c3.md"), "utf8"), "guess");
    const m = await bot.callTool({ name: "write_library_file", arguments: { path: "skills/new.md", content: "x" } });
    assert.equal(m.isError, true);
    const top = await bot.callTool({ name: "list_library", arguments: {} });
    assert.ok(!top.content[0].text.includes('"answers"'));
  } finally {
    await bot.close();
  }
});

test("over MCP: the writer gets the three new setup tools; the reader gets none of them", async () => {
  const d = await threeDrives();
  const writer = await client({ LIBRARY_ROOT: d.main, LIBRARY_PRIVATE_ROOT: d.priv, LIBRARY_ROLE: "writer" });
  const reader = await client({ LIBRARY_ROOT: d.main, LIBRARY_ROLE: "reader" });
  try {
    const before = ["append_library_file", "connect_library", "connect_private_drive", "disconnect_library", "edit_library_file", "find_library_keys", "library_status", "list_library", "read_library_file", "search_library", "write_library_file"];
    const w = await names(writer);
    assert.deepEqual(w.filter((n) => !before.includes(n)), ["connect_answers_drive", "connect_eval_bot", "disconnect_eval_bot"]);
    assert.ok(before.every((n) => w.includes(n)), "every tool from before is still there");
    assert.deepEqual(await names(reader), ["connect_library", "disconnect_library", "find_library_keys", "library_status", "list_library", "read_library_file", "search_library"]);
    const a = await writer.callTool({ name: "write_library_file", arguments: { path: "answers/x.md", content: "x" } });
    assert.equal(a.isError, true);
    assert.match(a.content[0].text, /connect my answers drive/);
    assert.deepEqual(await readdir(d.main), ["skills"]);
  } finally {
    await writer.close();
    await reader.close();
  }
});

test("over MCP: eval bot settings that don't name the bot's own Keychain item are refused (never your key)", async () => {
  const { env } = await sandbox();
  await writeConfig({ role: "writer", driveId: "L", keyStore: "keychain" }, env);
  await writeConfig({ role: "evalbot", driveId: "L", privateDriveId: "P", keyStore: "keychain" }, env, "evalbot"); // no keychainAccount
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LIBRARY_BACKEND: "", ...env, LIBRARY_IDENTITY: "evalbot" } }));
  try {
    const r = await c.callTool({ name: "list_library", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /eval bot isn't connected/);
    const s = await c.callTool({ name: "library_status", arguments: {} });
    assert.match(s.content[0].text, /isn't connected/);
  } finally {
    await c.close();
  }
});

test("a damaged Keychain value gives a plain error with none of its text in it", { skip: !onMac && "Keychain is Mac-only" }, async () => {
  const env = { LIBRARY_PLUGIN: "evaltest-bad" };
  const secretish = "-----BEGIN PRIVATE KEY-----SHOULD-NEVER-APPEAR";
  try {
    // storeKey only takes valid JSON, so the damaged value goes in through the security tool.
    const { spawnSync } = await import("node:child_process");
    spawnSync("/usr/bin/security", ["add-generic-password", "-U", "-s", svc, "-a", "evaltest-bad", "-w", Buffer.from(secretish).toString("base64")]);
    await assert.rejects(credentialsFor({ keyStore: "keychain", keychainService: svc }, env), (err) => {
      assert.match(err.message, /damaged/);
      assert.ok(!err.message.includes("PRIVATE") && !err.message.includes("SHOULD"), err.message);
      return true;
    });
  } finally {
    await deleteKey({ account: "evaltest-bad", service: svc });
  }
});
