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
import { readConfig } from "./config.js";
import { findKeys, connect, connectPrivate, status, disconnect, credentialsFor } from "./setup.js";

export const VERSION = "0.6.0";
const NOT_SET_UP = "Your library isn't set up on this machine yet. Say \"set up my library\" and I'll find your key and connect it.";
const READER_NO_PRIVATE = "Private files are open only to the library's own writer connection. This connection is read-only, so it can't see them.";
const PRIVATE_NOT_CONNECTED = "Your private drive isn't connected on this machine, so nothing under private/ can be read or written, and nothing was saved anywhere else. Say \"connect my private drive\" to connect it.";

const privateMessage = (role) => (role === "reader" ? READER_NO_PRIVATE : PRIVATE_NOT_CONNECTED);

export function libraryLoader(env = process.env) {
  if (env.LIBRARY_BACKEND === "local") {
    const role = env.LIBRARY_ROLE ?? "reader";
    const privateBackend = role === "writer" && env.LIBRARY_PRIVATE_ROOT ? new LocalFolderBackend(env.LIBRARY_PRIVATE_ROOT) : null;
    const backend = new SplitBackend({ main: new LocalFolderBackend(env.LIBRARY_ROOT), privateBackend, unavailable: privateMessage(role) });
    const lib = createLibrary({ backend, role });
    return { startRole: lib.role, get: async () => lib };
  }
  let cached;
  return {
    startRole: null,
    get: async () => {
      if (cached) return cached;
      const s = await readConfig(env);
      if (!s) throw new Error(NOT_SET_UP);
      const credentials = await credentialsFor(s, env);
      const privateBackend = s.role === "writer" && s.privateDriveId ? new DriveBackend({ driveId: s.privateDriveId, credentials }) : null;
      const backend = new SplitBackend({ main: new DriveBackend({ driveId: s.driveId, credentials }), privateBackend, unavailable: privateMessage(s.role) });
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
  const server = new McpServer({ name: "library", version: VERSION });

  server.registerTool("library_status", {
    description: `Check whether the ${name} is set up and reachable on this machine, and which library and role it uses.`,
    inputSchema: {},
  }, wrap(async () => (env.LIBRARY_BACKEND === "local" ? { connected: true, role: loader.startRole } : status(env))));

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

  if (writeTool) {
    server.registerTool("write_library_file", {
      description: `Create or replace a file in the ${name}. Only works with the writer key; Google refuses the reader's writes. A path starting private/ is saved in the separate private drive, never the main library; if no private drive is connected it is refused.`,
      inputSchema: { path: z.string().describe("Path inside the library; start it with private/ for files only the person may see"), content: z.string().describe("Full file content") },
    }, wrap(async ({ path, content }) => (await loader.get()).write(path, content)));

    server.registerTool("append_library_file", {
      description: `Add text to the end of a file in the ${name}, without sending the rest of the file. Use this for logs and running records (a new dated entry), and for any file too long to rewrite whole. Creates the file if it doesn't exist. Checks the saved copy afterwards. Writer key only; private/ paths go to the private drive.`,
      inputSchema: { path: z.string().describe("Path inside the library, e.g. MEMORY.md"), text: z.string().describe("Only the new text to add at the end") },
    }, wrap(async ({ path, text }) => (await loader.get()).append(path, text)));

    server.registerTool("edit_library_file", {
      description: `Change one piece of text inside a file in the ${name}, without sending the rest of the file: for example marking an open thread closed. The text to find must appear exactly once; if it appears more than once or not at all, nothing is changed. Checks the saved copy afterwards. Writer key only; private/ paths go to the private drive.`,
      inputSchema: {
        path: z.string().describe("Path inside the library"),
        find: z.string().describe("The exact text as it is now, long enough to appear only once"),
        replace: z.string().describe("What it should say instead"),
      },
    }, wrap(async ({ path, find, replace }) => (await loader.get()).edit(path, find, replace)));

    server.registerTool("connect_private_drive", {
      description: "Connect the separate private Shared Drive that holds files only the person may see (anything under private/). Uses the key already in this Mac's Keychain; picks the drive with \"private\" in its name. Pass drive only if asked to choose.",
      inputSchema: { drive: z.string().optional().describe("Private Shared Drive name or id, only when asked to choose") },
    }, wrap(async ({ drive }) => {
      const result = await connectPrivate({ drive, env });
      loader.reset?.();
      return result;
    }));
  }

  return server;
}

export async function main(env = process.env) {
  const loader = libraryLoader(env);
  let startRole = loader.startRole;
  if (!startRole) startRole = (await readConfig(env).catch(() => null))?.role ?? null;
  const server = await buildServer(loader, { env, writeTool: startRole !== "reader" });
  await server.connect(new StdioServerTransport());
}

const isMain = typeof import.meta.main === "boolean"
  ? import.meta.main
  : Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) await main();
