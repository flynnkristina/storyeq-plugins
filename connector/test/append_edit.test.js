import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLibrary } from "../src/library.js";
import { LocalFolderBackend } from "../src/backends/local.js";
import { SplitBackend } from "../src/backends/split.js";

async function setup() {
  const main = await mkdtemp(path.join(tmpdir(), "main-"));
  const priv = await mkdtemp(path.join(tmpdir(), "priv-"));
  await writeFile(path.join(main, "MEMORY.md"), "# Running log\n\n### 2026-09-15 - [agenda] - open thread [PENDING]\nthe cut\n\n### 2026-09-17 - [agenda] - open thread [PENDING]\nthe panels\n");
  return { main, priv };
}
const lib = (main, priv, role = "writer") =>
  createLibrary({ backend: new SplitBackend({ main: new LocalFolderBackend(main), privateBackend: priv ? new LocalFolderBackend(priv) : null }), role });

test("append adds only to the end and keeps everything before it", async () => {
  const { main, priv } = await setup();
  const before = await readFile(path.join(main, "MEMORY.md"), "utf8");
  const r = await lib(main, priv).append("MEMORY.md", "\n### 2026-11-07 - [general] - session log [CONFIRMED]\nnew entry\n");
  const after = await readFile(path.join(main, "MEMORY.md"), "utf8");
  assert.ok(after.startsWith(before));
  assert.ok(after.endsWith("new entry\n"));
  assert.equal(r.created, false);
});

test("append puts a line break in when the file doesn't end with one", async () => {
  const { main, priv } = await setup();
  await writeFile(path.join(main, "log.md"), "first");
  await lib(main, priv).append("log.md", "second\n");
  assert.equal(await readFile(path.join(main, "log.md"), "utf8"), "first\nsecond\n");
});

test("append creates a missing file, including its folders", async () => {
  const { main, priv } = await setup();
  const r = await lib(main, priv).append("logs/new.md", "hello\n");
  assert.equal(r.created, true);
  assert.equal(await readFile(path.join(main, "logs/new.md"), "utf8"), "hello\n");
});

test("a big file survives an append untouched", async () => {
  const { main, priv } = await setup();
  const big = "x".repeat(200_000) + "\n";
  await writeFile(path.join(main, "big.md"), big);
  await lib(main, priv).append("big.md", "tail\n");
  assert.equal(await readFile(path.join(main, "big.md"), "utf8"), big + "tail\n");
});

test("edit changes text that appears once, and nothing else", async () => {
  const { main, priv } = await setup();
  await lib(main, priv).edit("MEMORY.md", "[PENDING]\nthe cut", "[CLOSED 2026-11-07]\nthe cut");
  const after = await readFile(path.join(main, "MEMORY.md"), "utf8");
  assert.match(after, /\[CLOSED 2026-11-07\]\nthe cut/);
  assert.match(after, /\[PENDING\]\nthe panels/);
});

test("edit refuses text that appears more than once, and changes nothing", async () => {
  const { main, priv } = await setup();
  const before = await readFile(path.join(main, "MEMORY.md"), "utf8");
  await assert.rejects(lib(main, priv).edit("MEMORY.md", "[PENDING]", "[CLOSED]"), /appears 2 times/);
  assert.equal(await readFile(path.join(main, "MEMORY.md"), "utf8"), before);
});

test("edit refuses text that isn't there, and a file that isn't there", async () => {
  const { main, priv } = await setup();
  await assert.rejects(lib(main, priv).edit("MEMORY.md", "nope", "x"), /isn't in/);
  await assert.rejects(lib(main, priv).edit("missing.md", "a", "b"));
});

test("edit keeps $ signs in the new text exactly as written", async () => {
  const { main, priv } = await setup();
  await lib(main, priv).edit("MEMORY.md", "the cut", "a $20K day, $& $1");
  assert.match(await readFile(path.join(main, "MEMORY.md"), "utf8"), /a \$20K day, \$& \$1/);
});

test("the reader can't append or edit", async () => {
  const { main, priv } = await setup();
  await assert.rejects(lib(main, priv, "reader").append("MEMORY.md", "x"), /read-only/);
  await assert.rejects(lib(main, priv, "reader").edit("MEMORY.md", "the cut", "x"), /read-only/);
});

test("private/ appends and edits go to the private drive only, and are refused when it isn't connected", async () => {
  const { main, priv } = await setup();
  await lib(main, priv).append("private/inbox/done/note.md", "yours alone\n");
  await lib(main, priv).edit("private/inbox/done/note.md", "yours alone", "his alone");
  assert.equal(await readFile(path.join(priv, "inbox/done/note.md"), "utf8"), "his alone\n");
  assert.equal(existsSync(path.join(main, "private")), false);
  await assert.rejects(lib(main, null).append("private/x.md", "y"), /private/i);
  assert.deepEqual((await readdir(main)).sort(), ["MEMORY.md"]);
});
