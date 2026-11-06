import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createLibrary } from "../src/library.js";
import { LocalFolderBackend } from "../src/backends/local.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "../src/server.js");

async function makeLibrary() {
  const root = await mkdtemp(path.join(tmpdir(), "library-"));
  await mkdir(path.join(root, "judgments/agenda"), { recursive: true });
  await writeFile(path.join(root, "judgments/agenda/CP04_The_Cut.md"), "# The cut\n\nCut the panel when the sponsor owns the room.\n");
  await writeFile(path.join(root, "judgments/agenda/CP08_Running_Order.md"), "# Running order\n\nOpen with the strongest speaker.\n");
  await writeFile(path.join(root, ".hidden.md"), "secret\n");
  return root;
}

async function connect(root, role) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, LIBRARY_BACKEND: "local", LIBRARY_ROOT: root, LIBRARY_ROLE: role },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

test("reader can list, read and search", async () => {
  const lib = createLibrary({ backend: new LocalFolderBackend(await makeLibrary()), role: "reader" });
  const top = await lib.list();
  assert.deepEqual(top.map((e) => e.path), ["judgments"]);
  assert.match(await lib.read("judgments/agenda/CP04_The_Cut.md"), /sponsor owns the room/);
  const hits = await lib.search("SPONSOR");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "judgments/agenda/CP04_The_Cut.md");
  assert.equal(hits[0].matches[0].line, 3);
});

test("reader is refused a write", async () => {
  const root = await makeLibrary();
  const lib = createLibrary({ backend: new LocalFolderBackend(root), role: "reader" });
  await assert.rejects(lib.write("judgments/new.md", "x"), /read-only/);
});

test("writer can create and edit", async () => {
  const root = await makeLibrary();
  const lib = createLibrary({ backend: new LocalFolderBackend(root), role: "writer" });
  await lib.write("cases/case-001.md", "first");
  await lib.write("cases/case-001.md", "second");
  assert.equal(await readFile(path.join(root, "cases/case-001.md"), "utf8"), "second");
});

test("paths can't leave the library", async () => {
  const root = await makeLibrary();
  const lib = createLibrary({ backend: new LocalFolderBackend(root), role: "writer" });
  await assert.rejects(lib.read("../../etc/passwd"), /outside the library/);
  await assert.rejects(lib.write("../escape.md", "x"), /outside the library/);
  await assert.rejects(lib.read("/etc/passwd"), /relative/);
});

test("over MCP: the reader never sees the write tool", async () => {
  const root = await makeLibrary();
  const reader = await connect(root, "reader");
  const writer = await connect(root, "writer");
  try {
    const readerTools = (await reader.listTools()).tools.map((t) => t.name).sort();
    const writerTools = (await writer.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(readerTools, ["connect_library", "disconnect_library", "find_library_keys", "library_status", "list_library", "read_library_file", "search_library"]);
    assert.deepEqual(writerTools, ["connect_library", "connect_private_drive", "disconnect_library", "find_library_keys", "library_status", "list_library", "read_library_file", "search_library", "write_library_file"]);

    const read = await reader.callTool({ name: "read_library_file", arguments: { path: "judgments/agenda/CP08_Running_Order.md" } });
    assert.match(read.content[0].text, /strongest speaker/);

    const wrote = await writer.callTool({ name: "write_library_file", arguments: { path: "cases/c1.md", content: "hello" } });
    assert.ok(!wrote.isError);
    const readBack = await reader.callTool({ name: "read_library_file", arguments: { path: "cases/c1.md" } });
    assert.equal(readBack.content[0].text, "hello");

    const bad = await reader.callTool({ name: "read_library_file", arguments: { path: "../x" } });
    assert.equal(bad.isError, true);
  } finally {
    await reader.close();
    await writer.close();
  }
});
