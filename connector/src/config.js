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

export const configFile = (env) => path.join(configDir(env), "library.json");

export async function readConfig(env = process.env) {
  try {
    return JSON.parse(await fs.readFile(configFile(env), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`The library settings file is unreadable (${configFile(env)}): ${err.message}`);
  }
}

export async function writeConfig(config, env = process.env) {
  const dir = configDir(env);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await fs.writeFile(configFile(env), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return configFile(env);
}

export function roleFromEmail(email = "") {
  const local = email.split("@")[0].toLowerCase();
  if (local.includes("writer")) return "writer";
  if (local.includes("reader")) return "reader";
  return null;
}
