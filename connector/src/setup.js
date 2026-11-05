// Setup: find a library key on this machine, work out which library it can see,
// and save the settings locally. Never returns or logs any part of a private key.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import { configDir, readConfig, writeConfig, roleFromEmail } from "./config.js";
import { DriveBackend } from "./backends/drive.js";

const SEARCH_ROOTS = ["Downloads", "Desktop", "Documents", ".config"];
const SKIP = new Set(["node_modules", ".git", "Library", ".Trash"]);
const MAX_DEPTH = 4;
const MAX_KEY_BYTES = 20_000;

async function readKey(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_KEY_BYTES) return null;
  try {
    const d = JSON.parse(await fs.readFile(file, "utf8"));
    if (d.type !== "service_account" || !d.client_email || !d.private_key) return null;
    return { file, email: d.client_email, project: d.project_id, role: roleFromEmail(d.client_email) };
  } catch {
    return null;
  }
}

async function walk(dir, depth, found) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) await walk(full, depth + 1, found);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".json")) {
      const key = await readKey(full);
      if (key) found.push(key);
    }
  }
}

export async function findKeys({ home = os.homedir() } = {}) {
  const found = [];
  for (const root of SEARCH_ROOTS) await walk(path.join(home, root), 0, found);
  const seen = new Set();
  return found.filter((k) => !seen.has(k.file) && seen.add(k.file));
}

async function sharedDrives(keyFile) {
  const client = await new GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/drive"] }).getClient();
  try {
    const r = await client.request({ url: "https://www.googleapis.com/drive/v3/drives", params: { pageSize: 100 } });
    return r.data.drives ?? [];
  } catch (err) {
    throw new Error(`Google wouldn't sign in with this key: ${err.response?.data?.error?.message ?? err.message}`);
  }
}

export async function connect({ keyFile, drive, env = process.env }) {
  if (!keyFile) throw new Error("Give the key file's path (find_library_keys lists them)");
  const key = await readKey(path.resolve(keyFile.replace(/^~(?=\/)/, os.homedir())));
  if (!key) throw new Error("That file isn't a Google service-account key");
  if (!key.role) throw new Error(`Can't tell from ${key.email} whether this is the reader or the writer key`);

  const drives = await sharedDrives(key.file);
  if (!drives.length) {
    throw new Error(`The key works, but ${key.email} hasn't been added to any Shared Drive yet. Add it to the library's Shared Drive (writer as Content manager, reader as Viewer), then try again.`);
  }
  let chosen = drives.length === 1 ? drives[0] : null;
  if (drive) chosen = drives.find((d) => d.id === drive || d.name.toLowerCase() === String(drive).toLowerCase());
  if (!chosen) {
    return { connected: false, needsChoice: true, drives: drives.map((d) => d.name), message: "This key can see more than one Shared Drive. Say which is the library." };
  }

  const dir = configDir(env);
  const keysDir = path.join(dir, "keys");
  await fs.mkdir(keysDir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await fs.chmod(keysDir, 0o700);
  const stored = path.join(keysDir, `library-${key.role}.json`);
  if (path.resolve(key.file) !== stored) await fs.copyFile(key.file, stored);
  await fs.chmod(stored, 0o600);

  const settings = {
    driveId: chosen.id,
    driveName: chosen.name,
    keyFile: stored,
    role: key.role,
    account: key.email,
    connectedAt: new Date().toISOString(),
  };
  const where = await writeConfig(settings, env);
  const top = await new DriveBackend({ driveId: chosen.id, keyFile: stored }).list("");
  return {
    connected: true,
    library: chosen.name,
    role: key.role,
    settingsFile: where,
    keyStoredAt: stored,
    originalKeyFile: path.resolve(key.file) === stored ? null : key.file,
    topLevel: top.map((e) => e.path),
  };
}

export async function status(env = process.env) {
  const settings = await readConfig(env);
  if (!settings) return { connected: false, message: "Not set up on this machine yet." };
  try {
    const top = await new DriveBackend({ driveId: settings.driveId, keyFile: settings.keyFile }).list("");
    return { connected: true, library: settings.driveName, role: settings.role, account: settings.account, topLevel: top.map((e) => e.path) };
  } catch (err) {
    return { connected: false, library: settings.driveName, role: settings.role, message: `Set up, but not reachable: ${err.message}` };
  }
}
