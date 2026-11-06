// Setup: find a library key on this machine, work out which library it can see,
// and save the settings locally. Never returns or logs any part of a private key.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import { configDir, readConfig, writeConfig, roleFromEmail } from "./config.js";
import { DriveBackend } from "./backends/drive.js";
import { SERVICE, storeKey, readKeyJson, deleteKey } from "./keychain.js";

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
    return { file, email: d.client_email, project: d.project_id, keyId: d.private_key_id, role: roleFromEmail(d.client_email) };
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

async function sharedDrives(credentials) {
  const client = await new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/drive"] }).getClient();
  try {
    const r = await client.request({ url: "https://www.googleapis.com/drive/v3/drives", params: { pageSize: 100 } });
    return r.data.drives ?? [];
  } catch (err) {
    throw new Error(`Google wouldn't sign in with this key: ${err.response?.data?.error?.message ?? err.message}`);
  }
}

const pluginName = (env) => (env.LIBRARY_PLUGIN || "library").replace(/[^a-z0-9-]/gi, "");

const looksPrivate = (d) => /private/i.test(d.name ?? "");
const matches = (d, want) => d.id === want || d.name.toLowerCase() === String(want).toLowerCase();

// Which drive is the main library: the one asked for, the only drive, or the only one
// whose name doesn't say "private".
export function pickMain(drives, want) {
  if (want) return drives.find((d) => matches(d, want)) ?? null;
  if (drives.length === 1) return drives[0];
  const plain = drives.filter((d) => !looksPrivate(d));
  return plain.length === 1 ? plain[0] : null;
}

// Which drive holds private files: the one asked for, or the only other drive whose name
// says "private". Never the main drive, and never a guess between several.
export function pickPrivate(drives, mainId, want) {
  const others = drives.filter((d) => d.id !== mainId);
  if (want) return others.find((d) => matches(d, want)) ?? null;
  const named = others.filter(looksPrivate);
  return named.length === 1 ? named[0] : null;
}

export async function credentialsFor(settings, env = process.env) {
  if (settings.keyStore === "keychain") {
    const json = await readKeyJson({ account: pluginName(env), service: settings.keychainService ?? SERVICE });
    if (!json) throw new Error(`The library key isn't in this Mac's Keychain any more (looked for "${settings.keychainService ?? SERVICE}"). Say "set up my library" to connect it again.`);
    return JSON.parse(json);
  }
  return JSON.parse(await fs.readFile(settings.keyFile, "utf8"));
}

// Connect: check the key with Google, find its Shared Drive, put the key in the Keychain,
// check the Keychain copy works, then delete every file copy of that key it can find.
export async function connect({ keyFile, drive, env = process.env }) {
  if (!keyFile) throw new Error("Give the key file's path (find_library_keys lists them)");
  const key = await readKey(path.resolve(keyFile.replace(/^~(?=\/)/, os.homedir())));
  if (!key) throw new Error("That file isn't a Google service-account key");
  if (!key.role) throw new Error(`Can't tell from ${key.email} whether this is the reader or the writer key`);
  const keyJson = await fs.readFile(key.file, "utf8");
  const credentials = JSON.parse(keyJson);

  const drives = await sharedDrives(credentials);
  if (!drives.length) {
    throw new Error(`The key works, but ${key.email} hasn't been added to any Shared Drive yet. Add it to the library's Shared Drive (writer as Content manager, reader as Viewer), then try again.`);
  }
  const chosen = pickMain(drives, drive);
  if (!chosen) {
    return { connected: false, needsChoice: true, drives: drives.map((d) => d.name), message: "This key can see more than one Shared Drive. Say which is the library." };
  }

  const account = pluginName(env);
  await storeKey({ account, keyJson, label: `${SERVICE} (${account}, ${key.role})` });
  const back = JSON.parse((await readKeyJson({ account })) ?? "null");
  if (!back || back.private_key !== credentials.private_key || back.private_key_id !== credentials.private_key_id) {
    throw new Error("The key went into the Keychain but didn't read back the same, so nothing was deleted. Try again.");
  }
  const top = await new DriveBackend({ driveId: chosen.id, credentials: back }).list("");

  const priv = key.role === "writer" ? pickPrivate(drives, chosen.id) : null;
  const settings = {
    driveId: chosen.id,
    driveName: chosen.name,
    ...(priv ? { privateDriveId: priv.id, privateDriveName: priv.name } : {}),
    role: key.role,
    account: key.email,
    keyStore: "keychain",
    keychainService: SERVICE,
    connectedAt: new Date().toISOString(),
  };
  const where = await writeConfig(settings, env);

  // Every file copy of this same key, wherever setup looks, plus the one it was given.
  const copies = new Set([key.file]);
  for (const k of (await findKeys({ env })).keys) if (k.keyId && k.keyId === key.keyId) copies.add(k.file);
  const deleted = [];
  const notDeleted = [];
  for (const file of copies) {
    try {
      await fs.unlink(file);
      deleted.push(file);
    } catch (err) {
      notDeleted.push({ file, reason: err.message });
    }
  }
  await fs.rmdir(path.join(configDir(env), "keys")).catch(() => {});
  const otherKeys = (await findKeys({ env })).keys.map((k) => ({ file: k.file, account: k.email, role: k.role }));

  return {
    connected: true,
    library: chosen.name,
    privateDrive: priv ? priv.name : "none connected (private/ files are refused until one is)",
    role: key.role,
    keyNowLivesIn: `this Mac's Keychain, as "${SERVICE}" (${account})`,
    settingsFile: where,
    deletedCopies: deleted,
    couldNotDelete: notDeleted,
    otherKeysStillOnThisMac: otherKeys,
    topLevel: top.map((e) => e.path),
  };
}

// Connect the private drive to a library that's already set up, using the key already in
// the Keychain. Only the writer connection gets one.
export async function connectPrivate({ drive, env = process.env } = {}) {
  const settings = await readConfig(env);
  if (!settings) throw new Error("Your library isn't set up on this machine yet. Say \"set up my library\" first.");
  if (settings.role !== "writer") throw new Error("Only the library's writer connection can have a private drive. This one is read-only.");
  const credentials = await credentialsFor(settings, env);
  const drives = await sharedDrives(credentials);
  const priv = pickPrivate(drives, settings.driveId, drive);
  if (!priv) {
    const others = drives.filter((d) => d.id !== settings.driveId).map((d) => d.name);
    if (!others.length) {
      return { connected: false, message: `${settings.account} can't see any Shared Drive besides the library. Add it to the private drive as Content manager, then try again.` };
    }
    return { connected: false, needsChoice: true, drives: others, message: "Say which of these is the private drive." };
  }
  const top = await new DriveBackend({ driveId: priv.id, credentials }).list("");
  const where = await writeConfig({ ...settings, privateDriveId: priv.id, privateDriveName: priv.name }, env);
  return {
    connected: true,
    library: settings.driveName,
    privateDrive: priv.name,
    howToUse: "Anything saved under private/ now goes to the private drive. Nothing under private/ is ever saved in the main library.",
    settingsFile: where,
    privateTopLevel: top.map((e) => e.path),
  };
}

export async function status(env = process.env) {
  const settings = await readConfig(env);
  if (!settings) return { connected: false, message: "Not set up on this machine yet." };
  try {
    const credentials = await credentialsFor(settings, env);
    const top = await new DriveBackend({ driveId: settings.driveId, credentials }).list("");
    let privateDrive = settings.role === "reader" ? "not available to a read-only connection" : "none connected (private/ files are refused until one is)";
    if (settings.role === "writer" && settings.privateDriveId) {
      privateDrive = await new DriveBackend({ driveId: settings.privateDriveId, credentials }).list("")
        .then(() => `${settings.privateDriveName}, reachable`)
        .catch((err) => `${settings.privateDriveName}, NOT reachable: ${err.message}`);
    }
    return {
      connected: true,
      library: settings.driveName,
      privateDrive,
      role: settings.role,
      account: settings.account,
      keyLivesIn: settings.keyStore === "keychain" ? `Keychain, "${settings.keychainService}"` : settings.keyFile,
      topLevel: top.map((e) => e.path),
    };
  } catch (err) {
    return { connected: false, library: settings.driveName, role: settings.role, message: `Set up, but not reachable: ${err.message}` };
  }
}

// Disconnect: remove the key from the Keychain and the settings file. The key still works
// until it's deleted in Google Cloud, so the reply says so.
export async function disconnect(env = process.env) {
  const settings = await readConfig(env);
  const removedKey = await deleteKey({ account: pluginName(env), service: settings?.keychainService ?? SERVICE });
  let removedSettings = false;
  try {
    await fs.unlink(path.join(configDir(env), "library.json"));
    removedSettings = true;
  } catch {}
  return {
    removedFromKeychain: removedKey,
    removedSettings,
    stillToDo: settings?.account
      ? `Delete this key in Google Cloud (IAM, Service accounts, ${settings.account}, Keys) so it stops working everywhere.`
      : "Nothing was set up here.",
    otherKeysStillOnThisMac: (await findKeys({ env })).keys.map((k) => ({ file: k.file, account: k.email })),
  };
}
