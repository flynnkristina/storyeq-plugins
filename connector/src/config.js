// Where a machine's library settings live. The plugin carries no details: each machine
// keeps its own in ~/.config/<plugin>/library.json, written by connect_library.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function configDir(env = process.env) {
  if (env.LIBRARY_CONFIG_DIR) return env.LIBRARY_CONFIG_DIR;
  const plugin = (env.LIBRARY_PLUGIN || "library").replace(/[^a-z0-9-]/gi, "");
  return path.join(os.homedir(), ".config", plugin);
}

// Two connections can be set up on one Mac: the person's own ("library", the writer or the
// reader) and, beside a writer, the eval bot ("evalbot"). Each has its own settings file.
export const SETTINGS = { main: "library", evalbot: "evalbot" };

export const configFile = (env, name = SETTINGS.main) => path.join(configDir(env), `${name}.json`);

// Which connection this copy of the connector runs as. LIBRARY_IDENTITY=evalbot starts the
// eval bot's; anything else (including nothing) starts the person's own, as before.
export const identityOf = (env = process.env) => (env.LIBRARY_IDENTITY === "evalbot" ? "evalbot" : "main");

export async function readConfig(env = process.env, name = SETTINGS.main) {
  const file = configFile(env, name);
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`The library settings file is unreadable (${file}): ${err.message}`);
  }
}

export async function writeConfig(config, env = process.env, name = SETTINGS.main) {
  const dir = configDir(env);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const file = configFile(env, name);
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return file;
}

export function roleFromEmail(email = "") {
  const local = email.split("@")[0].toLowerCase();
  if (/(^|[-_.])eval-?bot([-_.]|$)/.test(local)) return "evalbot";
  if (local.includes("writer")) return "writer";
  if (local.includes("reader")) return "reader";
  return null;
}
