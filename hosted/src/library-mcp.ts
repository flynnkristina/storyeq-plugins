// The library's tools for one address. Same tool names and behaviour as the plugin's local
// connector (../../connector/src/server.js), minus the setup tools: on a hosted deploy there is
// nothing to set up on anyone's machine.

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { libraryFor, type RoleName } from "./roles";
import { instructionsFor } from "./instructions";
import { KINDS, LIMITS, sendNote, type NoteInput } from "./team-notes";

export const VERSION = "0.4.0";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const failure = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});
const wrap =
  <A,>(fn: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return text(await fn(args));
    } catch (err) {
      return failure(err);
    }
  };

const LABEL: Record<RoleName, string> = {
  team: "the team's library (read-only, plus sending notes to the leader)",
  leader: "the leader's library",
  evalbot: "the eval bot's library connection",
};

export function createServer(env: Env, role: RoleName, email: string) {
  const server = new McpServer({ name: "library", version: VERSION }, { instructions: instructionsFor(env, role) });
  const name = env.LIBRARY_NAME ?? "library";
  const lib = () => libraryFor(env, role);
  // Claude's chat doesn't pass a custom connection's own instructions to the model (tested
  // 2026-11-23), but it always reads tool descriptions, so the pointer rides there too.
  const start = role === "evalbot" ? "" : ` Before any work that uses the ${name}, read START_HERE.md first (or, if it's missing, ALWAYS.md then skills/INDEX.md).`;

  server.registerTool(
    "library_status",
    {
      description: `Check that the ${name} is reachable through this hosted connection, and which kind of connection it is.`,
      inputSchema: z.object({}),
    },
    wrap(async () => {
      const reach = async (folder: string) => {
        try { await lib().list(folder); return "reachable"; } catch (e) { return `NOT reachable (${(e as Error)?.message ?? "error"})`; }
      };
      const status: Record<string, unknown> = { connected: true, connection: LABEL[role], signedInAs: email, version: VERSION };
      if (role !== "team") status.privateDrive = `private/ (the private drive): ${await reach("private")}`;
      if (role === "leader") status.answersDrive = `answers/ (the answers drive): ${await reach("answers")}`;
      if (role === "evalbot") status.answersDrive = "answers/ (the answers drive): never opened by the eval bot";
      return status;
    }),
  );

  server.registerTool(
    "list_library",
    {
      description: `List the files and folders in the ${name}, or inside one folder of it.${start}`,
      inputSchema: z.object({ folder: z.string().optional().describe("Folder inside the library, e.g. skills. Leave empty for the top.") }),
    },
    wrap(async ({ folder }: { folder?: string }) => lib().list(folder)),
  );

  server.registerTool(
    "read_library_file",
    {
      description: `Read one file from the ${name}.${start}`,
      inputSchema: z.object({ path: z.string().describe("Path inside the library, e.g. skills/INDEX.md") }),
    },
    wrap(async ({ path }: { path: string }) => lib().read(path)),
  );

  server.registerTool(
    "search_library",
    {
      description: `Search the ${name} for words or a phrase. Returns matching files with the lines that matched.${start}`,
      inputSchema: z.object({
        query: z.string().describe("Words to look for"),
        limit: z.number().int().min(1).max(50).optional().describe("Most files to return (default 10)"),
      }),
    },
    wrap(async ({ query, limit }: { query: string; limit?: number }) => lib().search(query, Math.min(limit ?? 10, role === "team" ? 10 : 50))),
  );

  if (role === "team") {
    const leader = env.LEADER_NAME ?? "the leader";
    server.registerTool(
      "send_note_to_leader",
      {
        description:
          `Send this to ${leader}: add a short note to ${leader}'s private inbox. Use it when a team member says "send this to ${leader}", ` +
          `or says a rule in the ${name} is wrong, doesn't fit a case, or is missing, or says a piece of work is ready for ${leader}'s review. ` +
          `Before sending, show the team member the note (what it's about, which rule or doc, their reason) and send only after their yes. ` +
          `Put their reason in their own words, as they said it; never a summary or your own reasoning. ` +
          `Their sign-in email and the date are added automatically; don't ask for their name. ` +
          `This is the only thing this connection can save. It can't read the note back, and it can't change or delete anything. ` +
          `For finished work, also draft the email to ${leader} they would send anyway, from their own email, for them to send.`,
        inputSchema: z.object({
          kind: z.enum(KINDS).describe(`"rule" for a rule that doesn't fit or is missing; "work" for work ready for ${leader}'s review`),
          about: z.string().max(LIMITS.about).describe("What it's about, in a few words, e.g. Sponsor on the opening panel"),
          ruleOrDoc: z.string().max(LIMITS.target).optional().describe("Which rule or doc, e.g. S01 in judgments/agenda/CP07_Sponsor_Placement.md, or the agenda's name"),
          reason: z.string().max(LIMITS.reason).describe("The team member's reason, in their own words"),
          link: z.string().max(LIMITS.link).optional().describe("A link to the doc, if there is one (https only)"),
        }),
      },
      wrap(async (args: NoteInput) => sendNote(env, email, args)),
    );
    return server;
  }

  const evalbot = role === "evalbot";
  const where = evalbot
    ? "The eval bot can save only under private/ (in the private drive); anything else is refused, and answers/ is never opened."
    : "A path starting private/ is saved in the separate private drive, and one starting answers/ in the separate answers drive, never the main library.";
  const pathHelp = evalbot
    ? "Path inside the library; it must start with private/"
    : "Path inside the library; start it with private/ for files only the leader may see, or answers/ for eval answers";

  server.registerTool(
    "write_library_file",
    {
      description: `Create or replace a file in the ${name}. ${where}`,
      inputSchema: z.object({ path: z.string().describe(pathHelp), content: z.string().describe("Full file content") }),
    },
    wrap(async ({ path, content }: { path: string; content: string }) => lib().write(path, content)),
  );

  server.registerTool(
    "append_library_file",
    {
      description: `Add text to the end of a file in the ${name}, without sending the rest of the file. Use this for logs and running records, and for any file too long to rewrite whole. Creates the file if it doesn't exist. Checks the saved copy afterwards. ${where}`,
      inputSchema: z.object({ path: z.string().describe(pathHelp), text: z.string().describe("Only the new text to add at the end") }),
    },
    wrap(async ({ path, text }: { path: string; text: string }) => lib().append(path, text)),
  );

  server.registerTool(
    "edit_library_file",
    {
      description: `Change one piece of text inside a file in the ${name}, without sending the rest of the file. The text to find must appear exactly once; otherwise nothing is changed. Checks the saved copy afterwards. ${where}`,
      inputSchema: z.object({
        path: z.string().describe(pathHelp),
        find: z.string().describe("The exact text as it is now, long enough to appear only once"),
        replace: z.string().describe("What it should say instead"),
      }),
    },
    wrap(async ({ path, find, replace }: { path: string; find: string; replace: string }) => lib().edit(path, find, replace)),
  );

  return server;
}
