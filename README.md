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

## Shipping a change

1. Edit the plugin under `plugins/<name>/`.
2. Raise `version` in `plugins/<name>/.claude-plugin/plugin.json`. Without a new version, installed copies don't change.
3. Run `claude plugin validate .` (prints a pass), then commit and push.
