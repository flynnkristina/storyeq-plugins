---
name: setup
description: Sets up Kristina's library on this machine after Kristina OS is installed - finds her library key, connects it, and checks it works. Use when Kristina says "set up my library", "connect my library", "my library isn't connected", or right after installing Kristina OS, or when the library skill reports the library isn't set up.
---

# Kristina OS: set up the library

The plugin carries the connector but no details of any library. This skill connects it, once per machine, using a key file Kristina already has. Nothing about the library is typed in by hand.

Talk her through it in plain words, one step at a time. Never show, quote or open the contents of a key file.

## 1. Already set up?

Call `library_status`.
- **Connected:** say which library and role it's using, list its top-level folders, and stop. Nothing to do.
- **Set up, but not reachable:** say what went wrong in one plain sentence, then continue from step 2 to reconnect.
- **Not set up:** continue.

## 2. Find the key

Call `find_library_keys`. It looks in the plugin's private folder, then Downloads and Desktop.

- **One writer key found:** use it. Tell her the file name and the account.
- **Several found:** list them by file name and account, and ask which. Prefer a writer key for Kristina OS.
- **None found:** say: "I can't find your library key on this Mac. It's in 1Password, saved as a JSON file. Download it (to Downloads is fine), then tell me and I'll look again." Then wait. If she says it's in another folder, call `find_library_keys` again with that `folder`.

## 3. Connect

Call `connect_library` with the chosen key file.

- **Connected:** tell her the library's name, the role (writer can file things, reader can only read), and the top-level folders.
- **Asked to choose a drive:** list the drive names, ask which is her library, and call `connect_library` again with `drive`.
- **Key works but no Shared Drive:** say the account hasn't been added to the library's Shared Drive yet, and that whoever manages the drive needs to add it (writer as Content manager).
- **Any other error:** say it plainly and stop. Never work around it.

## 4. Tidy up

If the result gives an `originalKeyFile`, the key is now stored safely in `~/.config`. Tell her she can delete the copy in Downloads, and that 1Password still holds the original. Don't delete it yourself.

## 5. Prove it

Call `read_library_file` on `skills/INDEX.md` and list the skills in it, so she sees the library working. Then say: "You're set up. Say 'what's in my library' any time."
