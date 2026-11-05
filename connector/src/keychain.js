// The Mac's Keychain is the one place a library key lives. Uses Apple's built-in
// `security` tool. The key goes in through the tool's standard input, never as a
// command-line argument, so it never appears in the list of running programs.
import { spawn } from "node:child_process";

const SECURITY = "/usr/bin/security";
export const SERVICE = "StoryEQ library key";

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? "");
  });
}

const quote = (s) => `"${String(s).replace(/["\\]/g, "")}"`;

export async function storeKey({ account, keyJson, service = SERVICE, label }) {
  if (process.platform !== "darwin") throw new Error("Keychain storage needs a Mac");
  const secret = Buffer.from(JSON.stringify(JSON.parse(keyJson))).toString("base64");
  const cmd = `add-generic-password -U -s ${quote(service)} -a ${quote(account)} -l ${quote(label ?? `${service} (${account})`)} -w ${secret}\n`;
  const r = await run(["-i"], cmd);
  if (r.code !== 0 || /error/i.test(r.err)) throw new Error(`Keychain wouldn't save the key: ${r.err.trim() || `exit ${r.code}`}`);
}

export async function readKeyJson({ account, service = SERVICE }) {
  const r = await run(["find-generic-password", "-s", service, "-a", account, "-w"]);
  if (r.code !== 0) return null;
  return Buffer.from(r.out.trim(), "base64").toString("utf8");
}

export async function deleteKey({ account, service = SERVICE }) {
  const r = await run(["delete-generic-password", "-s", service, "-a", account]);
  return r.code === 0;
}
