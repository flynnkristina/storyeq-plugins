---
name: setup
description: Sets up, checks or disconnects Kristina's library on this Mac - finds the library key, moves it into the Mac's Keychain, deletes every other copy, connects her private drive, and checks it works. Use when Kristina says "set up my library", "connect my library", "my library isn't connected", "connect my private drive", "disconnect my library", or right after installing Kristina OS, or when the library skill reports the library or the private drive isn't connected.
---

# Kristina OS: set up the library

The plugin carries the connector but no details of any library. This skill connects it, once per Mac, using a key file downloaded from Google Cloud.

**The rule: the key lives in exactly one place, this Mac's Keychain.** Not in 1Password, not on the Desktop (it syncs to iCloud), not in Downloads. If a key is ever lost, the fix is a new key from Google Cloud, never a backup copy.

Talk her through it in plain words, one step at a time. Never show, quote or open the contents of a key file.

## 1. Already set up?

Call `library_status`.
- **Connected:** say which library and role it's using, that the key is in the Keychain, and list the top-level folders. Then check `privateDrive`: if it says none is connected, go to "Connect the private drive" below; otherwise stop.
- **Set up, but not reachable:** say what went wrong in one plain sentence, then continue from step 2 to reconnect.
- **Not set up:** continue.

## 2. Find the key

Call `find_library_keys`. It looks in Downloads and Desktop, where a key downloaded from Google Cloud lands.

- **One writer key found:** use it. Tell her the file name and the account.
- **Several found:** list them by file name and account, and ask which. Prefer a writer key for Kristina OS.
- **None found:** say: "I can't find a library key on this Mac. In Google Cloud, open the library-writer service account, then Keys, Add key, Create new key, JSON. It downloads to your Downloads folder. Tell me when it's there." Then wait. If she says it's in another folder, call `find_library_keys` again with that `folder`.

## 3. Connect

Call `connect_library` with the chosen key file. It checks the key with Google, finds the library's Shared Drive, saves the key in the Keychain, reads it back to check, and only then deletes the file and every other copy of that same key it can find.

- **Connected:** tell her:
  - the library's name and the role (writer can file things, reader can only read);
  - the private drive (`privateDrive`), or that none is connected yet, in which case go on to "Connect the private drive" after step 4;
  - that the key now lives only in this Mac's Keychain, under "StoryEQ library key";
  - each file it deleted (`deletedCopies`), by folder and name;
  - anything in `couldNotDelete`, with the reason, and ask her to delete it herself;
  - any `otherKeysStillOnThisMac`: these are different keys, so they were left alone. Name each one and ask whether it should go.
- **Asked to choose a drive:** list the drive names, ask which is her library, and call `connect_library` again with `drive`.
- **Key works but no Shared Drive:** say the account hasn't been added to the library's Shared Drive yet, and that whoever manages the drive needs to add it (writer as Content manager, reader as Viewer).
- **Any other error:** say it plainly and stop. Nothing has been deleted when connecting fails. Never work around it.

## 4. Prove it

Call `read_library_file` on `skills/INDEX.md` and list the skills in it, so she sees the library working. Then say: "You're set up. Say 'what's in my library' any time."

## Connect the private drive

Her private files (anything under `private/`) live in a second Shared Drive that only the writer account can open. Until it's connected, `private/` files are refused, never saved in the main library.

Call `connect_private_drive`. It uses the key already in the Keychain and picks the drive with "private" in its name.

- **Connected:** tell her the private drive's name, and that anything filed as private now goes there and never into the main library.
- **Asked to choose:** list the drive names, ask which is the private one, and call it again with `drive`.
- **Can't see another drive:** say the writer account needs adding to the private drive as Content manager (and the read-only account must never be added), then try again.

## Disconnect

When she asks to disconnect the library from this Mac, say what will happen: the key is removed from the Keychain and the settings are deleted. Wait for her yes, then call `disconnect_library`.

Afterwards, tell her the last step, which only she can do: delete that key in Google Cloud (the reply gives the account). Until then the key still works anywhere a copy exists.
