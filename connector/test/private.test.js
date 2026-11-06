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
import { SplitBackend, isPrivatePath } from "../src/backends/split.js";
import { pickMain, pickPrivate } from "../src/setup.js";

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/server.js");

async function twoDrives() {
  const main = await mkdtemp(path.join(tmpdir(), "main-"));
  const priv = await mkdtemp(path.join(tmpdir(), "priv-"));
  await mkdir(path.join(main, "skills"), { recursive: true });
  await writeFile(path.join(main, "skills/INDEX.md"), "# Skills\n\nshared word here\n");
  await mkdir(path.join(priv, "who"), { recursive: true });
  await writeFile(path.join(priv, "who/blind_spots.md"), "# Blind spots\n\nshared word, private line\n");
  return { main, priv };
}

const lib = (main, priv, role = "writer") =>
  createLibrary({
    backend: new SplitBackend({ main: new LocalFolderBackend(main), privateBackend: priv ? new LocalFolderBackend(priv) : null }),
    role,
  });

test("private/ is recognised however it's written", () => {
  for (const p of ["private", "private/x.md", "./private/x.md", "Private/x.md", "PRIVATE"]) assert.equal(isPrivatePath(p), true, p);
  for (const p of ["", "skills/private.md", "privately/x.md", "x/private/y.md"]) assert.equal(isPrivatePath(p), false, p);
});

test("private files are written to the private drive and never the main one", async () => {
  const { main, priv } = await twoDrives();
  const l = lib(main, priv);
  const r = await l.write("private/who/limits.md", "only me");
  assert.equal(r.path, "private/who/limits.md");
  assert.equal(r.private, true);
  assert.equal(await readFile(path.join(priv, "who/limits.md"), "utf8"), "only me");
  assert.equal(existsSync(path.join(main, "private")), false);
  assert.equal(await l.read("private/who/limits.md"), "only me");
});

test("with no private drive, private files are refused and nothing is saved", async () => {
  const { main } = await twoDrives();
  const l = lib(main, null);
  await assert.rejects(l.write("private/who/limits.md", "only me"), /private/);
  await assert.rejects(l.read("private/who/blind_spots.md"), /private/);
  await assert.rejects(l.list("private"), /private/);
  assert.deepEqual(await readdir(main), ["skills"]);
});

test("the top of the library shows private as one folder, and only when connected", async () => {
  const { main, priv } = await twoDrives();
  assert.deepEqual((await lib(main, priv).list()).map((e) => e.path), ["private", "skills"]);
  assert.deepEqual((await lib(main, null).list()).map((e) => e.path), ["skills"]);
  assert.deepEqual((await lib(main, priv).list("private")).map((e) => e.path), ["private/who"]);
});

test("search covers both drives and labels private hits", async () => {
  const { main, priv } = await twoDrives();
  const hits = (await lib(main, priv).search("shared word")).map((h) => h.path).sort();
  assert.deepEqual(hits, ["private/who/blind_spots.md", "skills/INDEX.md"]);
  const mainOnly = (await lib(main, null).search("shared word")).map((h) => h.path);
  assert.deepEqual(mainOnly, ["skills/INDEX.md"]);
});

test("private paths can't climb out of the private drive", async () => {
  const { main, priv } = await twoDrives();
  const l = lib(main, priv);
  await assert.rejects(l.read("private/../skills/INDEX.md"), /outside the library/);
  await assert.rejects(l.write("private", "x"), /file name/);
});

test("drive picking: main is the one not called private; private never guesses", () => {
  const lib1 = { id: "a", name: "Team library" };
  const p1 = { id: "b", name: "Team library private" };
  const p2 = { id: "c", name: "Old private stuff" };
  const other = { id: "d", name: "Other drive" };
  assert.equal(pickMain([lib1]), lib1);
  assert.equal(pickMain([lib1, p1]), lib1);
  assert.equal(pickMain([lib1, other]), null);
  assert.equal(pickMain([lib1, other], "other drive"), other);
  assert.equal(pickPrivate([lib1, p1], "a"), p1);
  assert.equal(pickPrivate([lib1, p1, p2], "a"), null);
  assert.equal(pickPrivate([lib1, other], "a"), null);
  assert.equal(pickPrivate([lib1, p1], "a", "a"), null);
  assert.equal(pickPrivate([lib1, p1, p2], "a", "Old private stuff"), p2);
});

async function client(env) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LIBRARY_BACKEND: "local", ...env } }));
  return c;
}

test("over MCP: writer saves private files to the private drive; reader can't reach them", async () => {
  const { main, priv } = await twoDrives();
  const writer = await client({ LIBRARY_ROOT: main, LIBRARY_PRIVATE_ROOT: priv, LIBRARY_ROLE: "writer" });
  const reader = await client({ LIBRARY_ROOT: main, LIBRARY_PRIVATE_ROOT: priv, LIBRARY_ROLE: "reader" });
  try {
    const w = await writer.callTool({ name: "write_library_file", arguments: { path: "private/notes.md", content: "mine" } });
    assert.ok(!w.isError, w.content?.[0]?.text);
    assert.equal(await readFile(path.join(priv, "notes.md"), "utf8"), "mine");
    assert.equal(existsSync(path.join(main, "private")), false);

    const r = await reader.callTool({ name: "read_library_file", arguments: { path: "private/notes.md" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /read-only/);
    const top = await reader.callTool({ name: "list_library", arguments: {} });
    assert.ok(!top.content[0].text.includes("private"));
  } finally {
    await writer.close();
    await reader.close();
  }
});
