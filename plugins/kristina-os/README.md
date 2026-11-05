# Kristina OS

Kristina's own Claude plugin. It holds one skill, `library`, which connects to her library and runs the skills and rules kept there. The skills themselves live in the library, not here, so they can improve without a plugin update.

## What it needs

A library connector set up on the same machine, giving Claude four tools: `list_library`, `read_library_file`, `search_library` and `write_library_file`. The connector and its key are set up separately and never live in this repo. Without them, the skill says the library isn't connected and stops.

## Try it

In a new session, say "what's in my library".
