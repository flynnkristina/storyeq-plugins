# StoryEQ plugins

A Claude plugin marketplace. It lists StoryEQ's plugins so they can be installed and kept up to date from Claude.

| Plugin | What it does |
|---|---|
| `kristina-os` | Kristina's own plugin. One skill connects to her library and runs the skills and rules kept there. |

## Add this marketplace

**Claude Code:**

```bash
claude plugin marketplace add flynnkristina/storyeq-plugins
```

```bash
claude plugin install kristina-os@storyeq
```

Each prints a short confirmation. Start a new session to use it.

**Claude desktop app or claude.ai:** Customize, then Plugins, then Add, then Add marketplace, and enter `flynnkristina/storyeq-plugins`.

## Get updates

```bash
claude plugin marketplace update storyeq
```

```bash
claude plugin update kristina-os@storyeq
```

The second prints the new version number. In the desktop app, turn on Sync automatically for the marketplace, or use Check for updates.

## What's not here, on purpose

This repo is public. It holds instructions only: no keys, no passwords, no library contents and no details of where a library lives. Each plugin carries its connector code, but the connection itself is set up on the person's own machine by the plugin's setup skill, which saves its settings in `~/.config/<plugin>/`.

## The connector

`connector/` is the source for the library connector every plugin carries. It's built with Bun into self-contained Mac programs (Apple chip and Intel), compressed, so the person needs nothing installed. After changing it: `npm install`, `npm test`, `npm run build`, then copy `connector/dist/library-arm64.gz` and `library-x64.gz` into each plugin's `connector/` folder (beside `start.sh`) and raise that plugin's version. Keys are kept in the Mac's Keychain, never in files.

### Three accounts, three drives

| Drive | Writer (the leader) | Reader (the team) | Eval bot |
|---|---|---|---|
| Library | read and write | read | read |
| Library's private drive (`private/`) | read and write | no access | read and write |
| Answers drive (`answers/`) | read and write | no access | **never a member** |

- Paths starting `private/` or `answers/` go to their own drive, never the library. If that drive isn't connected, they are refused, and nothing is saved anywhere else.
- Setup picks drives by name: the library is the one whose name says neither "private" nor "answer"; the private drive says "private"; the answers drive says "answer". If that leaves more than one choice, it asks. It never guesses.
- The eval bot is recognised by "evalbot" in its account name. It is refused `answers/` in code, and Google refuses it too, because it isn't a member of that drive. Setup won't connect it if it can see the answers drive.
- Each key is its own Keychain item: the person's own under the plugin's name, the eval bot's under `<plugin>:evalbot`. Connecting one never replaces the other, and `connect_library` refuses the eval bot's key outright.

**How the eval bot's connection starts (decided 15 Nov 2026).** It is never part of the person's everyday sessions. The same connector program runs as the eval bot only when started with `LIBRARY_IDENTITY=evalbot`, and then it offers just the library tools, with the bot's own key and settings (`~/.config/<plugin>/evalbot.json`). `connect_eval_bot` writes a ready-made `~/.config/<plugin>/eval-session.mcp.json`, refreshed each time the connector starts so it follows plugin updates, and replies with the line that starts an eval session using only that connection:

```
claude --strict-mcp-config --mcp-config ~/.config/<plugin>/eval-session.mcp.json --disallowedTools Bash "mcp__plugin_<plugin>_library__*"
```

Why this way: if the bot ran inside the leader's own session, that session could read `answers/` through the writer's connection and the guesses wouldn't be blind. A separate session that only has the bot's connection keeps the score honest. `--strict-mcp-config` skips every other MCP server, plugins included; `--disallowedTools` blocks the plugin's own library tools as a second lock, and takes away the shell, so the session can't ask the Keychain for the person's own key. What this doesn't stop: the person themselves, at their own Mac, can always read their own answers. The lock keeps the bot blind, not the leader.

A reader's connection never had an answers drive and handles `answers/` exactly as before (a plain path in the library). For a writer with no answers drive, `answers/` is refused, the same way `private/` is.

## Shipping a change

1. Edit the plugin under `plugins/<name>/`.
2. Raise `version` in `plugins/<name>/.claude-plugin/plugin.json`. Without a new version, installed copies don't change.
3. Run `claude plugin validate .` (prints a pass), then commit and push.
