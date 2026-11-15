#!/usr/bin/env node
// The library connector, as an MCP server. It carries no details of any library:
// the settings come from ~/.config/<plugin>/library.json (written by connect_library),
// or, for tests, from LIBRARY_BACKEND / LIBRARY_ROOT / LIBRARY_ROLE.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createLibrary } from "./library.js";
import { LocalFolderBackend } from "./backends/local.js";
import { DriveBackend } from "./backends/drive.js";
import { SplitBackend } from "./backends/split.js";
import { readConfig, identityOf, SETTINGS } from "./config.js";
import {
  findKeys, connect, connectPrivate, connectAnswers, connectEvalBot, disconnectEvalBot,
  evalBotStatus, writeEvalSessionFile, status, disconnect, credentialsFor, evalbotAccount,
} from "./setup.js";

export const VERSION = "0.8.0";
const NOT_SET_UP = "Your library isn't set up on this machine yet. Say \"set up my library\" and I'll find your key and connect it.";
const EVALBOT_NOT_SET_UP = "The eval bot isn't connected on this Mac yet. Connect it from your own session first (say \"connect the eval bot\").";
const READER_NO_PRIVATE = "Private files are open only to the library's own writer connection. This connection is read-only, so it can't see them.";
const PRIVATE_NOT_CONNECTED = "Your private drive isn't connected on this machine, so nothing under private/ can be read or written, and nothing was saved anywhere else. Say \"connect my private drive\" to connect it.";
const NO_ANSWERS_ACCESS = "The answers are open only to the leader's own writer connection. This connection can't see them.";
const ANSWERS_NOT_CONNECTED = "Your answers drive isn't connected on this machine, so nothing under answers/ can be read or written, and nothing was saved anywhere else. Say \"connect my answers drive\" to connect it.";

const privateMessage = (role) => (role === "reader" ? READER_NO_PRIVATE : PRIVATE_NOT_CONNECTED);
const answersMessage = (role) => (role === "writer" ? ANSWERS_NOT_CONNECTED : NO_ANSWERS_ACCESS);

function makeBackend({ role, main, priv, answers }) {
  return new SplitBackend({
    main,
    privateBackend: role !== "reader" ? priv : null,
    answersBackend: role === "writer" ? answers : null,
    unavailable: privateMessage(role),
    answersUnavailable: answersMessage(role),
    reserveAnswers: role !== "reader",
  });
}

export function libraryLoader(env = process.env) {
  const identity = identityOf(env);
  if (env.LIBRARY_BACKEND === "local") {
    const role = identity === "evalbot" ? "evalbot" : env.LIBRARY_ROLE ?? "reader";
    const local = (root) => (root ? new LocalFolderBackend(root) : null);
    const backend = makeBackend({ role, main: local(env.LIBRARY_ROOT), priv: local(env.LIBRARY_PRIVATE_ROOT), answers: local(env.LIBRARY_ANSWERS_ROOT) });
    const lib = createLibrary({ backend, role });
    return { identity, startRole: lib.role, get: async () => lib };
  }
  let cached;
  return {
    identity,
    startRole: null,
    get: async () => {
      if (cached) return cached;
      const s = await readConfig(env, identity === "evalbot" ? SETTINGS.evalbot : SETTINGS.main);
      if (!s) throw new Error(identity === "evalbot" ? EVALBOT_NOT_SET_UP : NOT_SET_UP);
      // The eval bot must load its own key, never the person's: refuse settings that don't
      // name its own Keychain item.
      if (identity === "evalbot" && (s.role !== "evalbot" || s.keychainAccount !== evalbotAccount(env))) throw new Error(EVALBOT_NOT_SET_UP);
      const credentials = await credentialsFor(s, env);
      const drive = (id, readOnly = false) => (id ? new DriveBackend({ driveId: id, credentials, readOnly }) : null);
      const backend = makeBackend({
        role: s.role,
        main: drive(s.driveId, s.role !== "writer"),
        priv: drive(s.privateDriveId),
        answers: drive(s.answersDriveId),
      });
      cached = createLibrary({ backend, role: s.role });
      return cached;
    },
    reset: () => { cached = undefined; },
  };
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (err) => ({ isError: true, content: [{ type: "text", text: err.message }] });
const wrap = (fn) => async (args) => {
  try {
    return text(await fn(args));
  } catch (err) {
    return failure(err);
  }
};

export async function buildServer(loader, { env = process.env, writeTool = true } = {}) {
  const name = env.LIBRARY_NAME ?? "library";
  const evalbot = (loader.identity ?? identityOf(env)) === "evalbot";
  const server = new McpServer({ name: "library", version: VERSION });

  server.registerTool("library_status", {
    description: evalbot
      ? `Check whether the eval bot's connection to the ${name} is set up and reachable on this machine.`
      : `Check whether the ${name} is set up and reachable on this machine, and which library and role it uses.`,
    inputSchema: {},
  }, wrap(async () => (env.LIBRARY_BACKEND === "local" ? { connected: true, role: loader.startRole } : evalbot ? evalBotStatus(env) : status(env))));

  if (evalbot) {
    registerReadTools(server, loader, name);
    registerWriteTools(server, loader, name, { evalbot: true });
    return server;
  }

  server.registerTool("find_library_keys", {
    description: "Look on this machine for Google service-account key files that could connect the library: the plugin's private folder, then Downloads and Desktop. Pass folder to look somewhere else. Returns each file's path, account and role, never key contents.",
    inputSchema: { folder: z.string().optional().describe("A folder to search instead, e.g. ~/Documents/Keys") },
  }, wrap(({ folder }) => findKeys({ env, folder })));

  server.registerTool("connect_library", {
    description: "Connect the library using a key file found by find_library_keys: checks the key with Google, finds the Shared Drive it can see, moves the key into this Mac's Keychain, then deletes every file copy of that key it can find. Pass drive only if asked to choose.",
    inputSchema: {
      keyFile: z.string().describe("Path to the key file"),
      drive: z.string().optional().describe("Shared Drive name or id, only when more than one is visible"),
    },
  }, wrap(async ({ keyFile, drive }) => {
    const result = await connect({ keyFile, drive, env });
    loader.reset?.();
    return result;
  }));

  server.registerTool("disconnect_library", {
    description: "Disconnect the library on this machine: removes its key from the Keychain and deletes the settings. Only when the person has asked to disconnect and said yes.",
    inputSchema: {},
  }, wrap(async () => {
    const result = await disconnect(env);
    loader.reset?.();
    return result;
  }));

  registerReadTools(server, loader, name);

  if (writeTool) {
    registerWriteTools(server, loader, name, { evalbot: false });

    server.registerTool("connect_private_drive", {
      description: "Connect the separate private Shared Drive that holds files only the person may see (anything under private/). Uses the key already in this Mac's Keychain; picks the drive with \"private\" in its name. Pass drive only if asked to choose.",
      inputSchema: { drive: z.string().optional().describe("Private Shared Drive name or id, only when asked to choose") },
    }, wrap(async ({ drive }) => {
      const result = await connectPrivate({ drive, env });
      loader.reset?.();
      return result;
    }));

    server.registerTool("connect_answers_drive", {
      description: "Connect the separate answers Shared Drive that holds the leader's real answers to eval cards (anything under answers/). Only the writer is a member of it; the eval bot never is. Uses the key already in this Mac's Keychain; picks the drive with \"answer\" in its name. Pass drive only if asked to choose.",
      inputSchema: { drive: z.string().optional().describe("Answers Shared Drive name or id, only when asked to choose") },
    }, wrap(async ({ drive }) => {
      const result = await connectAnswers({ drive, env });
      loader.reset?.();
      return result;
    }));

    server.registerTool("connect_eval_bot", {
      description: "Connect the eval bot's key (an account with \"evalbot\" in its name, found by find_library_keys). Checks it can read the library and the private drive and can NOT open the answers drive, saves its key in its own Keychain item (the person's own key is never touched), then deletes every file copy of it. Needs the writer library and the private drive set up first.",
      inputSchema: { keyFile: z.string().describe("Path to the eval bot's key file") },
    }, wrap(async ({ keyFile }) => connectEvalBot({ keyFile, env })));

    server.registerTool("disconnect_eval_bot", {
      description: "Remove the eval bot's key and settings from this Mac. The person's own library connection is left alone. Only when the person has asked and said yes.",
      inputSchema: {},
    }, wrap(async () => disconnectEvalBot(env)));
  }

  return server;
}

function registerReadTools(server, loader, name) {
  server.registerTool("list_library", {
    description: `List the files and folders in the ${name}, or inside one folder of it.`,
    inputSchema: { folder: z.string().optional().describe("Folder inside the library, e.g. skills. Leave empty for the top.") },
  }, wrap(async ({ folder }) => (await loader.get()).list(folder)));

  server.registerTool("read_library_file", {
    description: `Read one file from the ${name}.`,
    inputSchema: { path: z.string().describe("Path inside the library, e.g. skills/INDEX.md") },
  }, wrap(async ({ path }) => (await loader.get()).read(path)));

  server.registerTool("search_library", {
    description: `Search the ${name} for words or a phrase. Returns matching files with the lines that matched.`,
    inputSchema: {
      query: z.string().describe("Words to look for"),
      limit: z.number().int().min(1).max(50).optional().describe("Most files to return (default 10)"),
    },
  }, wrap(async ({ query, limit }) => (await loader.get()).search(query, limit ?? 10)));

}

function registerWriteTools(server, loader, name, { evalbot }) {
  const where = evalbot
    ? "The eval bot can save only under private/ (in the private drive); anything else is refused, and answers/ is never opened."
    : "A path starting private/ is saved in the separate private drive, and one starting answers/ in the separate answers drive, never the main library; if that drive isn't connected it is refused.";
  const pathHelp = evalbot
    ? "Path inside the library; it must start with private/"
    : "Path inside the library; start it with private/ for files only the person may see, or answers/ for eval answers";

  server.registerTool("write_library_file", {
    description: `Create or replace a file in the ${name}. ${evalbot ? "Eval bot key." : "Only works with the writer key; Google refuses the reader's writes."} ${where}`,
    inputSchema: { path: z.string().describe(pathHelp), content: z.string().describe("Full file content") },
  }, wrap(async ({ path, content }) => (await loader.get()).write(path, content)));

  server.registerTool("append_library_file", {
    description: `Add text to the end of a file in the ${name}, without sending the rest of the file. Use this for logs and running records (a new dated entry), and for any file too long to rewrite whole. Creates the file if it doesn't exist. Checks the saved copy afterwards. ${where}`,
    inputSchema: { path: z.string().describe(evalbot ? pathHelp : "Path inside the library, e.g. MEMORY.md"), text: z.string().describe("Only the new text to add at the end") },
  }, wrap(async ({ path, text }) => (await loader.get()).append(path, text)));

  server.registerTool("edit_library_file", {
    description: `Change one piece of text inside a file in the ${name}, without sending the rest of the file: for example marking an open thread closed. The text to find must appear exactly once; if it appears more than once or not at all, nothing is changed. Checks the saved copy afterwards. ${where}`,
    inputSchema: {
      path: z.string().describe(evalbot ? pathHelp : "Path inside the library"),
      find: z.string().describe("The exact text as it is now, long enough to appear only once"),
      replace: z.string().describe("What it should say instead"),
    },
  }, wrap(async ({ path, find, replace }) => (await loader.get()).edit(path, find, replace)));
}

export async function main(env = process.env) {
  const loader = libraryLoader(env);
  let startRole = loader.startRole;
  if (!startRole) {
    const file = loader.identity === "evalbot" ? SETTINGS.evalbot : SETTINGS.main;
    startRole = (await readConfig(env, file).catch(() => null))?.role ?? null;
  }
  // Keeps the eval session's launch file pointing at this copy of the connector after an
  // update. Only when an eval bot is connected; otherwise nothing is written.
  if (loader.identity === "main" && env.LIBRARY_BACKEND !== "local") {
    readConfig(env, SETTINGS.evalbot).then((bot) => (bot ? writeEvalSessionFile(env) : null)).catch(() => {});
  }
  const server = await buildServer(loader, { env, writeTool: startRole !== "reader" });
  await server.connect(new StdioServerTransport());
}

const isMain = typeof import.meta.main === "boolean"
  ? import.meta.main
  : Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) await main();
