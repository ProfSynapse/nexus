---
name: nexus
description: >-
  Read, search, and edit the user's Obsidian vault (notes, folders, canvas,
  tasks, memory/workspaces, saved prompts) from the shell via the `nexus` CLI —
  no MCP connection needed. Use whenever the user refers to their vault, notes,
  daily notes, second brain, or Obsidian, or asks you to find/read/change
  something stored there.
when_to_use: >-
  The task involves the user's Obsidian vault or notes and the `nexus` command
  is on PATH. Not for editing files in the current code repo — use normal file
  tools for those.
---

# Nexus vault CLI

`nexus` bridges the shell to a running Nexus (Obsidian) vault over a local
socket. Two steps: **discover**, then **use**.

## 1. Discover the tools you need (`nexus tools`)

`nexus tools` returns a live catalog. **Drill down to the narrowest thing you
need** — this keeps output small and gives you full argument schemas only for
the tools you'll actually call:

```
nexus tools                          # all agents (overview)
nexus tools storage                  # one agent's tools (compact)
nexus tools storage list             # ONE tool, full arg schema  ← prefer this
nexus tools "storage list, content read"   # several tools at once
```

Agents include: `content` (read/write/replace/insert notes), `storage`
(list/move/copy/archive files+folders), `search` (content/directory/memory),
`canvas`, `task`, `memory` (workspaces/states), `prompt`. Run `nexus tools`
once to see them all.

## 2. Run a tool (`nexus use`)

```
nexus use "<agent action --flags>" --memory "<what you're doing>" --goal "<objective>"
```

`--memory` and `--goal` are **required** (Nexus rejects calls without them).
Results are JSON on stdout.

```
nexus use "content read --path Daily/2026-07-17.md" \
  --memory "reviewing this week's notes" --goal "read today's daily note"

nexus use "search content --query 'context budget' --limit 5" \
  --memory "auditing retrieval work" --goal "find notes about the budget service"
```

## Choosing a vault

If exactly one vault is open, it's used automatically. If several are open,
`nexus` errors and lists them — run `nexus vaults` and add `--vault <name>`
(the human vault name works: `--vault "My Notes"`). You can also set
`NEXUS_VAULT` in the environment to pin one.

## Notes

- The search/list tools return **locations, not contents** — follow a hit with
  `content read --path <path>` to get the actual note.
- Reuse one stable `--session "<name>"` across a task so traces group together.
- If a command fails, run `nexus --help` or `nexus tools <that tool>` for the
  exact argument schema. If nothing connects, the vault's Obsidian window may be
  closed — ask the user to open it.
