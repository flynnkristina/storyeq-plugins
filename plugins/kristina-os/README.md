# Kristina OS

Kristina's own Claude plugin. It holds:

- the `library` skill, which connects to her library and runs the skills and rules kept there (the skills themselves live in the library, so they can improve without a plugin update);
- the `setup` skill, which connects the library on a Mac, and disconnects it;
- the library connector (`connector/`), which Claude starts on its own. It's a self-contained program, so nothing needs installing: no Node, no Python.

## What's not in it, on purpose

No keys, no account names and no details of where the library is.

## Where things live on a Mac

| What | Where |
|---|---|
| The library key | This Mac's Keychain, as "StoryEQ library key". Its only home. |
| Which library, and which role | `~/.config/kristina-os/library.json` (readable by you only) |

## First run on a Mac

1. Install the plugin from the StoryEQ marketplace.
2. In Google Cloud, create a JSON key for the library-writer service account. It downloads to Downloads.
3. In a new session, say "set up my library". It finds the key, checks it with Google, finds the library's Shared Drive, moves the key into the Keychain, and deletes the downloaded file.

## Taking it off a Mac

Say "disconnect my library". It removes the key from the Keychain and the settings file. Then delete that key in Google Cloud so it stops working everywhere.

Works on Apple-chip and Intel Macs, in Claude Code, the desktop app's Code tab, and Cowork. claude.ai chat can't run a connector on your Mac.
