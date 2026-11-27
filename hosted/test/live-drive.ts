// Live check against a real test library, run on the Mac before a deploy:
//   npm run test:live
// Reads the three test keys from this Mac's Keychain into memory only (never printed), builds
// each address's library exactly as the Worker does, and checks what each one may and may not do.
import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { libraryFor, mayUse } from "../src/roles";
import { sendNote } from "../src/team-notes";

const kc = (service: string, account: string) =>
  Buffer.from(
    execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], { encoding: "utf8" }).trim(),
    "base64",
  ).toString("utf8");
const plugin = process.env.LIBRARY_LIVE_PLUGIN ?? "kristina-os";
const settings = JSON.parse(execFileSync("cat", [`${process.env.HOME}/.config/${plugin}/library.json`], { encoding: "utf8" }));

const env: any = {
  MAIN_DRIVE_ID: settings.driveId,
  PRIVATE_DRIVE_ID: settings.privateDriveId,
  ANSWERS_DRIVE_ID: settings.answersDriveId,
  WRITER_KEY: kc("StoryEQ library key", plugin),
  READER_KEY: kc("StoryEQ library key (reader)", plugin),
  EVALBOT_KEY: kc("StoryEQ library key", `${plugin}:evalbot`),
  LEADER_NAME: "the leader",
  NOTES_FOLDER: "_connector_check/team-notes",
  LEADER_EMAILS: "leader@example.com",
  TEAM_DOMAINS: "example.com",
};

const refused = async (fn: () => Promise<unknown>, what: string) => {
  try {
    await fn();
  } catch {
    console.log(`ok   refused: ${what}`);
    return;
  }
  throw new Error(`NOT refused: ${what}`);
};

const stamp = new Date().toISOString();
const team = libraryFor(env, "team");
const leader = libraryFor(env, "leader");
const bot = libraryFor(env, "evalbot");

const top = await team.list("");
assert.ok(top.length > 0);
console.log(`ok   team lists the library (${top.length} items at the top)`);
const hits = await team.search("skill", 3);
console.log(`ok   team search runs (${hits.length} hits)`);
await refused(() => team.write("_connector_check/hosted.md", "x"), "team writing to the library");
await refused(() => team.read("private/anything.md"), "team reading private/");

const w = await leader.append("_connector_check/hosted_check.md", `- hosted connector check, leader, ${stamp}\n`);
console.log(`ok   leader appended to the library (${w.added} bytes)`);
await leader.append("private/_connector_check/hosted_check.md", `- hosted connector check, leader, ${stamp}\n`);
console.log("ok   leader appended under private/");
const answers = await leader.list("answers").catch((e: Error) => e);
assert.ok(!(answers instanceof Error), `leader couldn't open answers/: ${answers instanceof Error ? answers.message : ""}`);
console.log("ok   leader opens answers/");

await refused(() => bot.read("answers/anything.md"), "eval bot reading answers/");
await refused(() => bot.list("answers"), "eval bot listing answers/");
await refused(() => bot.write("_connector_check/bot.md", "x"), "eval bot writing outside private/");
await bot.append("private/_connector_check/hosted_check.md", `- hosted connector check, eval bot, ${stamp}\n`);
console.log("ok   eval bot appended under private/");
const botHits = await bot.search("answers", 10);
assert.ok(botHits.every((h: any) => !String(h.path).toLowerCase().startsWith("answers/")));
console.log("ok   eval bot search shows nothing from answers/");

const counts = new Map<string, string>();
const counter = { get: async (k: string) => counts.get(k) ?? null, put: async (k: string, v: string) => void counts.set(k, v) };
const note = await sendNote(env, "teammate@example.com", { kind: "rule", about: "hosted connector check", reason: `live check ${stamp}` }, { counter });
assert.ok(note.savedAs.startsWith("private/_connector_check/team-notes/"));
const saved = await leader.read(note.savedAs);
assert.ok(saved.includes("teammate@example.com") && saved.includes(`> live check ${stamp}`));
console.log(`ok   team note saved to the private drive and the leader reads it (${note.savedAs})`);
await refused(() => team.read(note.savedAs), "team reading the note it just sent");
await refused(() => team.list("private/_connector_check/team-notes"), "team listing the notes folder");

assert.equal(mayUse(env, "team", "someone@example.com"), true);
assert.equal(mayUse(env, "team", "someone@elsewhere.com"), false);
assert.equal(mayUse(env, "leader", "someone@example.com"), false);
assert.equal(mayUse(env, "leader", "LEADER@example.com"), true);
assert.equal(mayUse(env, "evalbot", "someone@example.com"), false);
assert.equal(mayUse({ LEADER_EMAILS: "" } as any, "leader", ""), false);
console.log("ok   who-may-use rules");
console.log("\nall live checks passed");
