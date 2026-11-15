// Live eval bot test against the real drives connected on this Mac. Skipped unless
// LIBRARY_LIVE_PLUGIN names a plugin (e.g. kristina-os) whose writer library, answers drive and
// eval bot are all connected. Uses the keys already in the Keychain; prints no key contents.
// Writes only under _tests/ in the private and answers drives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.js";
import { credentialsFor } from "../src/setup.js";
import { DriveBackend } from "../src/backends/drive.js";
import { libraryLoader } from "../src/server.js";

const plugin = process.env.LIBRARY_LIVE_PLUGIN;
const env = { ...process.env, LIBRARY_PLUGIN: plugin ?? "", LIBRARY_BACKEND: "" };
const writer = plugin ? await readConfig(env).catch(() => null) : null;
const bot = plugin ? await readConfig(env, "evalbot").catch(() => null) : null;
const skip = !(writer?.answersDriveId && bot) && "set LIBRARY_LIVE_PLUGIN to a plugin with its answers drive and eval bot connected";

test("live: the eval bot reads the library and writes to private", { skip }, async () => {
  const lib = await libraryLoader({ ...env, LIBRARY_IDENTITY: "evalbot" }).get();
  assert.equal(lib.role, "evalbot");
  assert.ok((await lib.list()).length > 0);
  const stamp = `evalbot-live-${Date.now()}`;
  const r = await lib.write(`private/_tests/${stamp}.md`, `guess ${stamp}\n`);
  assert.equal(r.private, true);
  assert.equal(await lib.read(`private/_tests/${stamp}.md`), `guess ${stamp}\n`);
  await assert.rejects(lib.write(`_tests/${stamp}.md`, "x"), /only save under private/);
});

test("live: the eval bot is refused answers/, by the code and by Google", { skip }, async () => {
  const lib = await libraryLoader({ ...env, LIBRARY_IDENTITY: "evalbot" }).get();
  await assert.rejects(lib.list("answers"), /never opens answers/);
  // Straight at Google, skipping every check in the code: the bot must not open the drive.
  const credentials = await credentialsFor(bot, env);
  const direct = new DriveBackend({ driveId: writer.answersDriveId, credentials, readOnly: true });
  await assert.rejects(direct.list(""), /Google|404|not found/i);
  // And Google refuses the bot's write to the library, even if the code were bypassed.
  const library = new DriveBackend({ driveId: writer.driveId, credentials });
  await assert.rejects(library.write(`_tests/evalbot-should-fail-${Date.now()}.md`, "x"), /Google/);
});

test("live: the writer reaches the answers drive; the two keys are different accounts", { skip }, async () => {
  const lib = await libraryLoader(env).get();
  const stamp = `answers-live-${Date.now()}`;
  const r = await lib.write(`answers/_tests/${stamp}.md`, `answer ${stamp}\n`);
  assert.equal(r.answers, true);
  assert.equal(await lib.read(`answers/_tests/${stamp}.md`), `answer ${stamp}\n`);
  const mine = await credentialsFor(writer, env);
  const bots = await credentialsFor(bot, env);
  assert.notEqual(mine.client_email, bots.client_email);
  assert.notEqual(mine.private_key_id, bots.private_key_id);
});
