// Drive backend against a fake Google: checks what is asked of Drive, without a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DriveBackend } from "../src/backends/drive.js";

const FOLDER = "application/vnd.google-apps.folder";
const DRIVE = "drive1";

// A tiny in-memory Drive. Items: { id, name, mimeType, parent, text }.
function fakeDrive(items) {
  const calls = [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const client = {
    async request(opts) {
      calls.push(opts);
      const { url, params = {} } = opts;
      const q = params.q ?? "";
      if (url.endsWith("/files") && q.includes("fullText contains")) {
        const phrase = q.match(/fullText contains '"(.*?)"'/)[1].toLowerCase();
        const files = items.filter((i) => i.mimeType !== FOLDER && (i.text ?? "").toLowerCase().includes(phrase));
        return { data: { files: files.map(({ id, name, mimeType, parent }) => ({ id, name, mimeType, parents: [parent] })) } };
      }
      if (url.endsWith("/files") && q.startsWith("modifiedTime >")) {
        const files = items.filter((i) => i.mimeType !== FOLDER && i.recent);
        return { data: { files: files.map(({ id, name, mimeType, parent }) => ({ id, name, mimeType, parents: [parent] })) } };
      }
      if (url.endsWith("/files") && q.includes(" in parents")) {
        const parent = q.match(/^'(.*?)' in parents/)[1];
        const name = q.match(/name = '(.*?)'/)?.[1];
        const files = items.filter((i) => i.parent === parent && (!name || i.name === name));
        return { data: { files: files.map(({ id, name, mimeType }) => ({ id, name, mimeType })) } };
      }
      const exp = url.match(/\/files\/(.*?)\/export$/);
      if (exp) return { data: `export:${params.mimeType}:${byId.get(exp[1]).text}` };
      const one = url.match(/\/files\/([^/]+)$/);
      if (one && params.alt === "media") return { data: byId.get(one[1]).text };
      if (one) {
        const f = byId.get(one[1]);
        return { data: { id: f.id, name: f.name, parents: [f.parent] } };
      }
      throw new Error(`unexpected request ${url}`);
    },
  };
  return { client, calls };
}

const tree = [
  { id: "f-skills", name: "skills", mimeType: FOLDER, parent: DRIVE },
  { id: "f-judg", name: "judgments", mimeType: FOLDER, parent: DRIVE },
  { id: "f-agenda", name: "agenda", mimeType: FOLDER, parent: "f-judg" },
  { id: "a1", name: "debrief.md", mimeType: "text/markdown", parent: "f-skills", text: "# Debrief\nrun my debrief\n" },
  { id: "a2", name: "CP01.md", mimeType: "text/markdown", parent: "f-agenda", text: "line one\nRun My Debrief here too\n" },
  { id: "a3", name: "big.md", mimeType: "text/markdown", parent: "f-skills", text: "nothing to see\n" },
  { id: "s1", name: "answers", mimeType: "application/vnd.google-apps.spreadsheet", parent: DRIVE, text: "a,b\n1,2" },
  { id: "h1", name: ".hidden", mimeType: FOLDER, parent: DRIVE },
  { id: "a4", name: "secret.md", mimeType: "text/markdown", parent: "h1", text: "run my debrief\n" },
];

test("reader asks Google for read-only Drive access, writer for full", () => {
  assert.equal(new DriveBackend({ driveId: DRIVE, credentials: { client_email: "x" }, readOnly: true }).scope, "https://www.googleapis.com/auth/drive.readonly");
  assert.equal(new DriveBackend({ driveId: DRIVE, credentials: { client_email: "x" } }).scope, "https://www.googleapis.com/auth/drive");
});

test("a lookup asks for one name per folder, and remembers folders", async () => {
  const { client, calls } = fakeDrive(tree);
  const d = new DriveBackend({ driveId: DRIVE, client });
  assert.match(await d.read("judgments/agenda/CP01.md"), /Run My Debrief/);
  assert.ok(calls.every((c) => !c.params?.q || c.params.q.includes("name =") || c.params.alt), "every lookup is by name");
  const before = calls.length;
  await d.read("judgments/agenda/CP01.md");
  assert.equal(calls.length - before, 2, "second read: one lookup for the file, one download; folders came from memory");
});

test("search opens only the files Drive says match, and returns their paths", async () => {
  const { client, calls } = fakeDrive(tree);
  const d = new DriveBackend({ driveId: DRIVE, client });
  const hits = await d.search("run my debrief");
  assert.deepEqual(hits.map((h) => h.path).sort(), ["judgments/agenda/CP01.md", "skills/debrief.md"]);
  const downloads = calls.filter((c) => c.params?.alt === "media").map((c) => c.url.split("/").pop());
  assert.ok(!downloads.includes("a3"), "the file without the words is never opened");
  assert.ok(!hits.some((h) => h.path.includes("secret")), "nothing under a hidden folder");
});

test("a Google Sheet reads as CSV", async () => {
  const { client } = fakeDrive(tree);
  const d = new DriveBackend({ driveId: DRIVE, client });
  assert.equal(await d.read("answers"), "export:text/csv:a,b\n1,2");
});

test("a moved folder is looked up again instead of failing", async () => {
  const items = tree.map((i) => ({ ...i }));
  const { client } = fakeDrive(items);
  const d = new DriveBackend({ driveId: DRIVE, client });
  await d.read("skills/debrief.md");
  const skills = items.find((i) => i.id === "f-skills");
  items.push({ ...skills, id: "f-skills-2" });
  skills.parent = "elsewhere";
  items.find((i) => i.id === "a1").parent = "f-skills-2";
  assert.match(await d.read("skills/debrief.md"), /Debrief/);
});

test("search also finds a file written moments ago, before Drive has indexed it", async () => {
  const items = [...tree, { id: "n1", name: "new.md", mimeType: "text/markdown", parent: "f-skills", text: "brand new stamp 123\n", recent: true, unindexed: true }];
  const { client } = fakeDrive(items.map((i) => (i.unindexed ? { ...i, text: i.text } : i)));
  // the fake's text index sees every file, so take the new one out of it to act like Drive's lag
  const original = client.request;
  client.request = async (opts) => {
    const r = await original(opts);
    if (opts.params?.q?.includes("fullText")) r.data.files = r.data.files.filter((f) => f.id !== "n1");
    return r;
  };
  const d = new DriveBackend({ driveId: DRIVE, client });
  assert.deepEqual((await d.search("stamp 123")).map((h) => h.path), ["skills/new.md"]);
});
