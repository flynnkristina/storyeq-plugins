// Setup: find a library key on this machine, work out which library it can see,
// and save the settings locally. Never returns or logs any part of a private key.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import { configDir, readConfig, writeConfig, roleFromEmail, SETTINGS } from "./config.js";
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
  // Listing drives only reads, so it never needs more than read-only access.
  const client = await new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/drive.readonly"] }).getClient();
  try {
    const r = await client.request({ url: "https://www.googleapis.com/drive/v3/drives", params: { pageSize: 100 } });
    return r.data.drives ?? [];
  } catch (err) {
    throw new Error(`Google wouldn't sign in with this key: ${err.response?.data?.error?.message ?? err.message}`);
  }
}

const pluginName = (env) => (env.LIBRARY_PLUGIN || "library").replace(/[^a-z0-9-]/gi, "");

const looksPrivate = (d) => /private/i.test(d.name ?? "");
const looksAnswers = (d) => /answer/i.test(d.name ?? "");
const matches = (d, want) => d.id === want || d.name.toLowerCase() === String(want).toLowerCase();
// A drive whose name says both "private" and "answer" is never picked on its own: setup asks.
const isPrivateNamed = (d) => looksPrivate(d) && !looksAnswers(d);
const isAnswersNamed = (d) => looksAnswers(d) && !looksPrivate(d);

// Which drive is the main library: the one asked for, the only drive, or the only one whose
// name says neither "private" nor "answer". A lone drive named for answers is never the library.
export function pickMain(drives, want) {
  if (want) return drives.find((d) => matches(d, want)) ?? null;
  if (drives.length === 1) return looksAnswers(drives[0]) ? null : drives[0];
  const plain = drives.filter((d) => !looksPrivate(d) && !looksAnswers(d));
  return plain.length === 1 ? plain[0] : null;
}

// Which drive holds private files: the one asked for, or the only other drive whose name
// says "private". Never the main drive, and never a guess between several.
export function pickPrivate(drives, mainId, want) {
  const others = drives.filter((d) => d.id !== mainId);
  if (want) return others.find((d) => matches(d, want)) ?? null;
  const named = others.filter(isPrivateNamed);
  return named.length === 1 ? named[0] : null;
}

// Which drive holds the eval answers: the one asked for, or the only drive not already in use
// whose name says "answer". Never the library or the private drive, and never a guess.
export function pickAnswers(drives, usedIds = [], want) {
  const others = drives.filter((d) => !usedIds.includes(d.id));
  if (want) return others.find((d) => matches(d, want)) ?? null;
  const named = others.filter(isAnswersNamed);
  return named.length === 1 ? named[0] : null;
}

// The person's own key is the Keychain item named after the plugin. The eval bot's is a
// separate item ("<plugin>:evalbot"; a plugin name can't contain ":", so it can't be another
// plugin's own item), and saving one can never replace the other.
export const evalbotAccount = (env) => `${pluginName(env)}:evalbot`;

// Parses a key read from the Keychain without ever putting any of its text in an error.
function parseKey(json, what = "The library key") {
  if (json == null) return null;
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`${what} in this Mac's Keychain is damaged. Connect it again from a new key.`);
  }
}

export async function credentialsFor(settings, env = process.env) {
  if (settings.keyStore === "keychain") {
    const json = await readKeyJson({ account: settings.keychainAccount ?? pluginName(env), service: settings.keychainService ?? SERVICE });
    if (!json) throw new Error(`The library key isn't in this Mac's Keychain any more (looked for "${settings.keychainService ?? SERVICE}"). Say "set up my library" to connect it again.`);
    return parseKey(json);
  }
  return JSON.parse(await fs.readFile(settings.keyFile, "utf8"));
}

const NO_ANSWERS = "none connected (answers/ files are refused until one is)";

// Deletes every file copy of this same key, wherever setup looks, plus the one it was given.
async function deleteCopies(key, env) {
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
  return { deleted, notDeleted, otherKeys };
}

// Connect: check the key with Google, find its Shared Drive, put the key in the Keychain,
// check the Keychain copy works, then delete every file copy of that key it can find.
export async function connect({ keyFile, drive, env = process.env }) {
  if (!keyFile) throw new Error("Give the key file's path (find_library_keys lists them)");
  const key = await readKey(path.resolve(keyFile.replace(/^~(?=\/)/, os.homedir())));
  if (!key) throw new Error("That file isn't a Google service-account key");
  if (!key.role) throw new Error(`Can't tell from ${key.email} whether this is the reader or the writer key`);
  if (key.role === "evalbot") throw new Error(`${key.email} is the eval bot's key, not your own. Connect it with connect_eval_bot, after your own library is set up. Nothing was changed.`);
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
  const back = parseKey(await readKeyJson({ account }));
  if (!back || back.private_key !== credentials.private_key || back.private_key_id !== credentials.private_key_id) {
    throw new Error("The key went into the Keychain but didn't read back the same, so nothing was deleted. Try again.");
  }
  const top = await new DriveBackend({ driveId: chosen.id, credentials: back, readOnly: key.role !== "writer" }).list("");

  const priv = key.role === "writer" ? pickPrivate(drives, chosen.id) : null;
  const answers = key.role === "writer" ? pickAnswers(drives, [chosen.id, priv?.id]) : null;
  const settings = {
    driveId: chosen.id,
    driveName: chosen.name,
    ...(priv ? { privateDriveId: priv.id, privateDriveName: priv.name } : {}),
    ...(answers ? { answersDriveId: answers.id, answersDriveName: answers.name } : {}),
    role: key.role,
    account: key.email,
    keyStore: "keychain",
    keychainService: SERVICE,
    connectedAt: new Date().toISOString(),
  };
  const where = await writeConfig(settings, env);

  const { deleted, notDeleted, otherKeys } = await deleteCopies(key, env);

  return {
    connected: true,
    library: chosen.name,
    privateDrive: priv ? priv.name : "none connected (private/ files are refused until one is)",
    ...(key.role === "writer" ? { answersDrive: answers ? answers.name : NO_ANSWERS } : {}),
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

// Connect the answers drive to a writer library that's already set up, using the key already
// in the Keychain. Mirrors connectPrivate. The eval answers live there, where the eval bot is
// never a member.
export async function connectAnswers({ drive, env = process.env } = {}) {
  const settings = await readConfig(env);
  if (!settings) throw new Error("Your library isn't set up on this machine yet. Say \"set up my library\" first.");
  if (settings.role !== "writer") throw new Error("Only the library's writer connection can have an answers drive. This one is read-only.");
  const credentials = await credentialsFor(settings, env);
  const drives = await sharedDrives(credentials);
  const used = [settings.driveId, settings.privateDriveId].filter(Boolean);
  const ans = pickAnswers(drives, used, drive);
  if (!ans) {
    const others = drives.filter((d) => !used.includes(d.id)).map((d) => d.name);
    if (!others.length) {
      return { connected: false, message: `${settings.account} can't see any Shared Drive besides the library${settings.privateDriveId ? " and the private drive" : ""}. Add it to the answers drive as Content manager, then try again.` };
    }
    return { connected: false, needsChoice: true, drives: others, message: "Say which of these is the answers drive." };
  }
  const evalbot = await readConfig(env, SETTINGS.evalbot);
  if (evalbot) {
    // Fails closed: if the bot's access can't be checked, the answers drive isn't connected.
    let botCreds;
    try {
      botCreds = await credentialsFor(evalbot, env);
    } catch {
      throw new Error("An eval bot is connected on this Mac, but its key can't be read, so it can't be checked that it's kept out of the answers drive. Disconnect the eval bot or connect it again first. Nothing was changed.");
    }
    const seen = await sharedDrives(botCreds);
    const opened = await new DriveBackend({ driveId: ans.id, credentials: botCreds, readOnly: true }).canOpenDrive();
    if (opened || seen.some((d) => d.id === ans.id)) {
      throw new Error(`The eval bot (${evalbot.account}) can open "${ans.name}", so it could read the answers. Remove it from that drive's members first. Nothing was changed.`);
    }
  }
  const top = await new DriveBackend({ driveId: ans.id, credentials }).list("");
  const where = await writeConfig({ ...settings, answersDriveId: ans.id, answersDriveName: ans.name }, env);
  return {
    connected: true,
    library: settings.driveName,
    answersDrive: ans.name,
    howToUse: "Anything saved under answers/ now goes to the answers drive. Nothing under answers/ is ever saved in the main library, and the eval bot can't open it.",
    settingsFile: where,
    answersTopLevel: top.map((e) => e.path),
  };
}

// The eval bot's own MCP set-up, for starting an eval session that has ONLY the bot's
// connection. It points at the connector's current start.sh, so it is rewritten whenever the
// connector starts. Two locks keep the person's own connection out of that session:
// --strict-mcp-config skips every other MCP server (plugins included), and --disallowedTools
// blocks the plugin's own library tools by name in case one is ever loaded anyway. It also
// takes away the shell, so the session can't ask the Keychain for the person's own key.
export const evalSessionFile = (env) => path.join(configDir(env), "eval-session.mcp.json");

export const evalSessionCommand = (env) =>
  `claude --strict-mcp-config --mcp-config ${evalSessionFile(env)} --disallowedTools Bash "mcp__plugin_${pluginName(env)}_library__*"`;

export async function writeEvalSessionFile(env = process.env) {
  if (!env.LIBRARY_HOME) return null;
  const file = evalSessionFile(env);
  const config = {
    mcpServers: {
      "library-evalbot": {
        command: "/bin/sh",
        args: [path.join(env.LIBRARY_HOME, "start.sh")],
        env: { LIBRARY_PLUGIN: pluginName(env), LIBRARY_NAME: `${env.LIBRARY_NAME ?? "library"} (eval bot)`, LIBRARY_IDENTITY: "evalbot" },
      },
    },
  };
  const next = JSON.stringify(config, null, 2) + "\n";
  const current = await fs.readFile(file, "utf8").catch(() => null);
  if (current !== next) {
    await fs.mkdir(configDir(env), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, next, { mode: 0o600 });
  }
  return file;
}

// What's wrong with the drives an eval bot can see, or null if they're right: it must see the
// library and the private drive, and must not see the answers drive or anything named for answers.
export function evalBotDriveProblem(drives, settings, email = "The eval bot") {
  const sees = (id) => drives.some((d) => d.id === id);
  const leak = drives.filter((d) => d.id === settings.answersDriveId || looksAnswers(d));
  if (leak.length) {
    return `${email} can see ${leak.map((d) => `"${d.name}"`).join(" and ")}, so it could read the real answers. Remove it from that drive's members, then try again. Nothing was changed.`;
  }
  const fix = [];
  if (!sees(settings.driveId)) fix.push(`add it to "${settings.driveName}" as Viewer`);
  if (!sees(settings.privateDriveId)) fix.push(`add it to "${settings.privateDriveName}" as Content manager`);
  return fix.length ? `The key works, but ${email} can't reach everything it needs yet: ${fix.join("; ")}. Then try again. Nothing was changed.` : null;
}

// Connect the eval bot: a third service account that reads the library, reads and writes the
// private drive (where its guesses go), and is never a member of the answers drive. Its key
// goes in its own Keychain item and its settings in their own file, so the person's own key
// and settings are never touched.
export async function connectEvalBot({ keyFile, env = process.env }) {
  if (!keyFile) throw new Error("Give the eval bot's key file path (find_library_keys lists them)");
  const settings = await readConfig(env);
  if (!settings || settings.role !== "writer") {
    throw new Error("The eval bot connects beside your own writer library. Set that up first (say \"set up my library\"). Nothing was changed.");
  }
  if (!settings.privateDriveId) {
    throw new Error("The eval bot saves its guesses in your private drive, and none is connected yet. Say \"connect my private drive\" first. Nothing was changed.");
  }
  const key = await readKey(path.resolve(keyFile.replace(/^~(?=\/)/, os.homedir())));
  if (!key) throw new Error("That file isn't a Google service-account key");
  if (key.role !== "evalbot") throw new Error(`${key.email} isn't the eval bot's account (its name needs "evalbot" in it). Nothing was changed.`);
  const keyJson = await fs.readFile(key.file, "utf8");
  const credentials = JSON.parse(keyJson);

  // Check what the bot can see BEFORE its key is saved anywhere.
  const problem = evalBotDriveProblem(await sharedDrives(credentials), settings, key.email);
  if (problem) throw new Error(problem);

  // Google's own answer, not just the drive list: the bot must not be able to open the
  // answers drive at all.
  if (settings.answersDriveId) {
    const opened = await new DriveBackend({ driveId: settings.answersDriveId, credentials, readOnly: true }).canOpenDrive();
    if (opened) throw new Error(`Google let the eval bot open "${settings.answersDriveName}". Remove it from that drive's members, then try again. Nothing was changed.`);
  }
  await new DriveBackend({ driveId: settings.driveId, credentials, readOnly: true }).list("");
  const privTop = await new DriveBackend({ driveId: settings.privateDriveId, credentials }).list("");

  const account = evalbotAccount(env);
  await storeKey({ account, keyJson, label: `${SERVICE} (${account})` });
  const back = parseKey(await readKeyJson({ account }), "The eval bot's key");
  if (!back || back.private_key !== credentials.private_key || back.private_key_id !== credentials.private_key_id) {
    throw new Error("The eval bot's key went into the Keychain but didn't read back the same, so nothing was deleted. Try again.");
  }
  const where = await writeConfig({
    driveId: settings.driveId,
    driveName: settings.driveName,
    privateDriveId: settings.privateDriveId,
    privateDriveName: settings.privateDriveName,
    role: "evalbot",
    account: key.email,
    keyStore: "keychain",
    keychainService: SERVICE,
    keychainAccount: account,
    connectedAt: new Date().toISOString(),
  }, env, SETTINGS.evalbot);
  const sessionFile = await writeEvalSessionFile(env);
  const { deleted, notDeleted, otherKeys } = await deleteCopies(key, env);

  return {
    connected: true,
    evalBot: key.email,
    reads: settings.driveName,
    readsAndWrites: settings.privateDriveName,
    neverOpens: settings.answersDriveName ?? "the answers drive (none connected yet: connect it before the first eval)",
    keyNowLivesIn: `this Mac's Keychain, as "${SERVICE}" (${account}), separate from your own key`,
    yourOwnKey: "unchanged",
    settingsFile: where,
    ...(sessionFile ? { startAnEvalSession: evalSessionCommand(env) } : {}),
    deletedCopies: deleted,
    couldNotDelete: notDeleted,
    otherKeysStillOnThisMac: otherKeys,
    privateTopLevel: privTop.map((e) => e.path),
  };
}

// The eval bot's own status, from its own settings and key.
export async function evalBotStatus(env = process.env) {
  const settings = await readConfig(env, SETTINGS.evalbot);
  if (!settings || settings.role !== "evalbot" || settings.keychainAccount !== evalbotAccount(env)) {
    return { connected: false, message: "The eval bot isn't connected on this Mac. Connect it from your own session with connect_eval_bot." };
  }
  try {
    const credentials = await credentialsFor(settings, env);
    const top = await new DriveBackend({ driveId: settings.driveId, credentials, readOnly: true }).list("");
    const privateDrive = await new DriveBackend({ driveId: settings.privateDriveId, credentials }).list("")
      .then(() => `${settings.privateDriveName}, reachable`)
      .catch((err) => `${settings.privateDriveName}, NOT reachable: ${err.message}`);
    return {
      connected: true,
      role: "evalbot",
      account: settings.account,
      library: settings.driveName,
      privateDrive,
      answers: "never opened by the eval bot",
      keyLivesIn: `Keychain, "${settings.keychainService}" (${settings.keychainAccount})`,
      topLevel: top.map((e) => e.path),
    };
  } catch (err) {
    return { connected: false, role: "evalbot", library: settings.driveName, message: `Set up, but not reachable: ${err.message}` };
  }
}

// Removes the eval bot's key and settings from this Mac. The person's own are left alone.
export async function disconnectEvalBot(env = process.env) {
  const settings = await readConfig(env, SETTINGS.evalbot).catch(() => null);
  const removedKey = await deleteKey({ account: evalbotAccount(env), service: settings?.keychainService ?? SERVICE });
  let removedSettings = false;
  try {
    await fs.unlink(path.join(configDir(env), `${SETTINGS.evalbot}.json`));
    removedSettings = true;
  } catch {}
  await fs.unlink(evalSessionFile(env)).catch(() => {});
  return {
    removedFromKeychain: removedKey,
    removedSettings,
    yourOwnKey: "unchanged",
    stillToDo: settings?.account
      ? `Delete this key in Google Cloud (IAM, Service accounts, ${settings.account}, Keys) so it stops working everywhere.`
      : "No eval bot was set up here.",
  };
}

export async function status(env = process.env) {
  const settings = await readConfig(env);
  if (!settings) return { connected: false, message: "Not set up on this machine yet." };
  try {
    const credentials = await credentialsFor(settings, env);
    const top = await new DriveBackend({ driveId: settings.driveId, credentials, readOnly: settings.role !== "writer" }).list("");
    let privateDrive = settings.role === "reader" ? "not available to a read-only connection" : "none connected (private/ files are refused until one is)";
    if (settings.role === "writer" && settings.privateDriveId) {
      privateDrive = await new DriveBackend({ driveId: settings.privateDriveId, credentials }).list("")
        .then(() => `${settings.privateDriveName}, reachable`)
        .catch((err) => `${settings.privateDriveName}, NOT reachable: ${err.message}`);
    }
    const extra = {};
    if (settings.role === "writer") {
      extra.answersDrive = settings.answersDriveId
        ? await new DriveBackend({ driveId: settings.answersDriveId, credentials }).list("")
          .then(() => `${settings.answersDriveName}, reachable`)
          .catch((err) => `${settings.answersDriveName}, NOT reachable: ${err.message}`)
        : NO_ANSWERS;
      const bot = await readConfig(env, SETTINGS.evalbot).catch(() => null);
      extra.evalBot = bot ? `${bot.account}, connected (its key is a separate Keychain item)` : "not connected";
      if (bot) extra.startAnEvalSession = evalSessionCommand(env);
    }
    return {
      connected: true,
      library: settings.driveName,
      privateDrive,
      ...extra,
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
  const bot = await readConfig(env, SETTINGS.evalbot).catch(() => null);
  return {
    removedFromKeychain: removedKey,
    removedSettings,
    ...(bot ? { evalBot: `${bot.account} is still connected on this Mac, with its own key. Ask to disconnect the eval bot to remove it too.` } : {}),
    stillToDo: settings?.account
      ? `Delete this key in Google Cloud (IAM, Service accounts, ${settings.account}, Keys) so it stops working everywhere.`
      : "Nothing was set up here.",
    otherKeysStillOnThisMac: (await findKeys({ env })).keys.map((k) => ({ file: k.file, account: k.email })),
  };
}
