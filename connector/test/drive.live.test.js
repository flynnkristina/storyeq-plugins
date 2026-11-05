// Live test against a real Shared Drive. Skipped unless these are set:
//   LIBRARY_DRIVE_ID, LIBRARY_WRITER_KEY, LIBRARY_READER_KEY
// It writes only under _tests/ in that drive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DriveBackend } from "../src/backends/drive.js";
import { createLibrary } from "../src/library.js";

const { LIBRARY_DRIVE_ID: driveId, LIBRARY_WRITER_KEY: writerKey, LIBRARY_READER_KEY: readerKey } = process.env;
const skip = !(driveId && writerKey && readerKey) && "set LIBRARY_DRIVE_ID, LIBRARY_WRITER_KEY, LIBRARY_READER_KEY to run";

test("drive: writer writes, reader reads, lists and searches", { skip }, async () => {
  const writer = createLibrary({ backend: new DriveBackend({ driveId, keyFile: writerKey }), role: "writer" });
  const reader = createLibrary({ backend: new DriveBackend({ driveId, keyFile: readerKey }), role: "reader" });
  const stamp = `roundtrip ${Date.now()}`;
  const first = await writer.write("_tests/nested/roundtrip.md", `# Test\n\n${stamp}\n`);
  assert.equal(first.path, "_tests/nested/roundtrip.md");
  const second = await writer.write("_tests/nested/roundtrip.md", `# Test\n\n${stamp} edited\n`);
  assert.equal(second.created, false);
  assert.match(await reader.read("_tests/nested/roundtrip.md"), /edited/);
  assert.ok((await reader.list("_tests/nested")).some((e) => e.path === "_tests/nested/roundtrip.md"));
  const found = await reader.search(stamp);
  assert.ok(found.some((r) => r.path === "_tests/nested/roundtrip.md"));
});

test("drive: reader is refused a write, by us and by Google", { skip }, async () => {
  const reader = createLibrary({ backend: new DriveBackend({ driveId, keyFile: readerKey }), role: "reader" });
  await assert.rejects(reader.write("_tests/nope.md", "x"), /read-only/);
  const bypass = createLibrary({ backend: new DriveBackend({ driveId, keyFile: readerKey }), role: "writer" });
  await assert.rejects(bypass.write("_tests/nested/roundtrip.md", "x"), /Google refused/);
});

test("drive: paths can't leave the library", { skip }, async () => {
  const reader = createLibrary({ backend: new DriveBackend({ driveId, keyFile: readerKey }), role: "reader" });
  await assert.rejects(reader.read("../secret.md"), /outside the library/);
});
