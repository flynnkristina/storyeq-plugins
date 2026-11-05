import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findKeys } from "../src/setup.js";
import { roleFromEmail, configDir } from "../src/config.js";

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/server.js");
const fakeKey = (email) => JSON.stringify({ type: "service_account", client_email: email, project_id: "p", private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n" });

test("finds service-account keys without returning their contents", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "home-"));
  await mkdir(path.join(home, "Downloads/nested"), { recursive: true });
  await writeFile(path.join(home, "Downloads/nested/k1.json"), fakeKey("library-writer@p.iam.gserviceaccount.com"));
  await writeFile(path.join(home, "Downloads/other.json"), JSON.stringify({ hello: "world" }));
  const found = await findKeys({ home });
  assert.equal(found.length, 1);
  assert.equal(found[0].role, "writer");
  assert.ok(!JSON.stringify(found).includes("PRIVATE KEY"));
});

test("role comes from the account name", () => {
  assert.equal(roleFromEmail("library-writer@x.iam.gserviceaccount.com"), "writer");
  assert.equal(roleFromEmail("library-reader@x.iam.gserviceaccount.com"), "reader");
  assert.equal(roleFromEmail("someone@x.com"), null);
});

test("settings live under ~/.config/<plugin>", () => {
  assert.match(configDir({ LIBRARY_PLUGIN: "kristina-os" }), /\.config\/kristina-os$/);
});

test("not set up: the library tools say how to set up, and nothing breaks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cfg-"));
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LIBRARY_BACKEND: "", LIBRARY_CONFIG_DIR: dir } }));
  try {
    const r = await client.callTool({ name: "list_library", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /set up my library/);
    const s = await client.callTool({ name: "library_status", arguments: {} });
    assert.match(s.content[0].text, /Not set up/);
  } finally {
    await client.close();
  }
});
