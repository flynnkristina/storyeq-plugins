import { test } from "node:test";
import assert from "node:assert/strict";
import { storeKey, readKeyJson, deleteKey } from "../src/keychain.js";

const skip = process.platform !== "darwin" && "Keychain is Mac-only";
const svc = "StoryEQ library key (test)";

test("keychain: save, read back the same, delete", { skip }, async () => {
  const fake = JSON.stringify({ type: "service_account", client_email: "t@x", private_key: "fake\nmultiline\n", private_key_id: "abc" });
  await storeKey({ account: "selftest", keyJson: fake, service: svc });
  assert.equal(await readKeyJson({ account: "selftest", service: svc }), JSON.stringify(JSON.parse(fake)));
  await storeKey({ account: "selftest", keyJson: fake.replace("abc", "def"), service: svc });
  assert.match(await readKeyJson({ account: "selftest", service: svc }), /def/);
  assert.equal(await deleteKey({ account: "selftest", service: svc }), true);
  assert.equal(await readKeyJson({ account: "selftest", service: svc }), null);
});
