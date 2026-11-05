// Setup: find a library key on this machine, work out which library it can see,
// and save the settings locally. Never returns or logs any part of a private key.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import { configDir, readConfig, writeConfig, roleFromEmail } from "./config.js";
import { DriveBackend } from "./backends/drive.js";

const SKIP = new Set(["node_modules", ".git", "Library", ".Trash"]);
const MAX_KEY_BYTES = 20_000;
const PER_FILE_MS = 1_000;
const TOTAL_MS = 5_000;
const MAX_FILES = 2_000;

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms).unref())]);

async function readKey(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_KEY_BYTES) return null;
    const raw = await withTimeout(fs.readFile(file, "utf8"), PER_FILE_MS);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (d.type !== "service_account" || !d.client_email || !d.private_key) return null;
    return { file, email: d.client_email, project: d.project_id, role: roleFromEmail(d.client_email) };
  } catch {
    return null;
  }
}

async function walk(dir, depth, maxDepth, found, budget) {
  if (depth > maxDepth || Date.now() > budget.deadline || budget.files > MAX_FILES) return;
  let entries;
  try {
    entries = await withTimeout(fs.readdir(dir, { withFileTypes: true }), PER_FILE_MS);
  } catch {
    return;
  }
  for (const e of entries ?? []) {
    if (Date.now() > budget.deadline || budget.files > MAX_FILES) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name) && !e.name.startsWith(".")) await walk(full, depth + 1, maxDepth, found, budget);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".json")) {
      budget.files++;
      const key = await readKey(full);
      if (key) found.push(key);
    }
  }
}

// Looks where a downloaded key actually lands: the plugin's own private folder,
// then Downloads and Desktop (top level and one folder down). A folder can be named
// to look somewhere else. Never reads a file over 20 KB; never returns key contents.
export async function findKeys({ home = os.homedir(), env = process.env, folder } = {}) {
  const roots = folder
    ? [[path.resolve(folder.replace(/^~(?=\/|$)/, home)), 2]]
    : [[path.join(configDir(env), "keys"), 0], [path.join(home, "Downloads"), 1], [path.join(home, "Desktop"), 1]];
  const found = [];
  const budget = { deadline: Date.now() + TOTAL_MS, files: 0 };
  for (const [root, maxDepth] of roots) await walk(root, 0, maxDepth, found, budget);
  const seen = new Set();
  const keys = found.filter((k) => !seen.has(k.file) && seen.add(k.file));
  return { searched: roots.map(([r]) => r), stoppedEarly: Date.now() > budget.deadline || budget.files > MAX_FILES, keys };
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
