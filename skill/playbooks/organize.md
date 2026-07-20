---
name: organize
intent: Restructure the vault — map what's there, then move / archive / create folders to tidy it
tools: [storage list, storage create-folder, storage move, storage copy, storage archive, search query-notes, search directory, memory list-workspaces, memory create-state]
---

# Playbook: organize

Reshape vault structure: **map → plan → move/archive**. Use it for "file these
notes into folders," "archive last year's dailies," "split this folder," etc.
Unlike `vault-work` (which edits note *bodies*), this moves and files whole notes.

## Protocol

1. **Load a workspace** (see the spine above); thread `--workspace`/`--session`.
2. **Map the current layout before touching anything.**
   - `storage list --path "<folder>"` — see what's in a folder.
   - `search query-notes --sql "…"` — query frontmatter as a database to *find*
     what to move (e.g. all notes with `status: archived`, or created before a
     date). Read-only SELECT; run with `--describe` first to see the columns.
   - `search directory --query "<name>"` — locate notes/folders by name.
3. **Plan the moves** — decide target folders. Create any missing folder first
   with `storage create-folder --path "<folder>"`.
4. **Execute, one file at a time**, verifying each result:
   - `storage move --path <src> --new-path <dst>` — relocate/rename (both paths
     validated; target's parent folder must exist).
   - `storage copy --path <src> --new-path <dst>` — duplicate instead of move.
   - `storage archive --path <path>` — soft-remove (reversible), for retiring a
     note without deleting it.
5. **Checkpoint** with `memory create-state` after a batch, so a bad reshuffle is
   restorable.

## Worked example — archive old daily notes into a subfolder

```
# 1. load the workspace
nexus use \
  --memory "tidying old dailies" --goal "load the journal workspace" \
  --session tidy-dailies \
  -- memory load-workspace --workspace journal

# 2. map — which dailies are from 2025? (query frontmatter; --describe to see columns first)
nexus use \
  --workspace journal --session tidy-dailies \
  --memory "finding 2025 dailies to archive" --goal "list 2025 daily notes" \
  -- search query-notes --sql "SELECT path FROM notes WHERE path LIKE 'Daily/2025-%' ORDER BY path"

# 3. make the destination folder
nexus use \
  --workspace journal --session tidy-dailies \
  --memory "have the 2025 list; creating archive folder" --goal "create Daily/Archive/2025" \
  -- storage create-folder --path Daily/Archive/2025

# 4. move each note (one call per file — verify each)
nexus use \
  --workspace journal --session tidy-dailies \
  --memory "moving 2025 dailies into the archive folder" --goal "move 2025-01-03.md" \
  -- storage move --path Daily/2025-01-03.md --new-path Daily/Archive/2025/2025-01-03.md

# 5. checkpoint after the batch
nexus use \
  --workspace journal --session tidy-dailies \
  --memory "2025 dailies archived" --goal "checkpoint the reorg" \
  -- memory create-state --name dailies-archived \
  --conversation-context "moved all 2025 daily notes into Daily/Archive/2025" \
  --active-task "archive old dailies" \
  --active-files "[Daily/Archive/2025]" \
  --next-steps "[do the same for 2024]"
```

## Pitfalls

- **Moving before the target folder exists** — `storage move`'s target parent
  must exist; `create-folder` it first.
- **Bulk-moving blind** — map with `list`/`query-notes` first; one `move` per
  file so a failure is isolated, not a half-done sweep.
- **`archive` ≠ delete** — it's the reversible soft-remove; there is no
  destructive delete for the agent. That's a feature — prefer it.
- **`query-notes` is read-only** — it finds notes; it never changes them. Use its
  output as the move list.
- **Paths are vault-relative and confined** — no `..`/`~`/absolute on either
  `--path` or `--new-path`.
