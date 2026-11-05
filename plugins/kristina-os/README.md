# Kristina OS

Kristina's own Claude plugin. It holds:

- the `library` skill, which connects to her library and runs the skills and rules kept there (the skills themselves live in the library, so they can improve without a plugin update);
- the `setup` skill, which connects the library on a new machine;
- the library connector (`connector/library.mjs`), which Claude starts on its own.

## What's not in it, on purpose

No keys, no account names and no details of where the library is. Each machine keeps its own settings in `~/.config/kristina-os/library.json`, written by the setup skill.

## First run on a machine

1. Install the plugin from the StoryEQ marketplace.
2. Download the library key from 1Password (Downloads is fine).
3. In a new session, say "set up my library". It finds the key, checks it with Google, finds the library's Shared Drive, stores the key privately in `~/.config/kristina-os/`, and lists what's in the library.

Needs Node.js 20 or later on the machine. Works in Claude Code and the desktop app's Code tab and Cowork; claude.ai chat can't run a connector on your machine.
