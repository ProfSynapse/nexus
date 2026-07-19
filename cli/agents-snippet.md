## Nexus vault access

This machine runs Nexus (Obsidian). To read, search, or edit the user's vault —
notes, folders, canvas, tasks, memory/workspaces, saved prompts — use the
`nexus` CLI. No MCP connection is needed.

**Run `nexus --help` first.** It's the authoritative, always-current manual
(commands, the required context contract, CLI syntax, gotchas, tool catalog) —
offline and instant, so read it before your first command instead of guessing.

- **Discover:** `nexus tools [selector]` returns tool schemas (not vault data).
  Drill down: `nexus tools storage list` = one tool's full arg schema.
- **Execute:** `nexus use "<agent command --flags>" --memory "<what you're doing>" --goal "<objective>"`.
  `--memory`/`--goal` are **required** on every `use`.
- **Task recipes:** `nexus playbook <name>` emits a ready-to-run recipe plus your
  workspaces and preloaded tools in one call (`nexus playbook` lists them).
- Search/list results are **locations, not contents** — follow a hit with
  `content read --path <path> --start-line 1` (read requires a start line).
  `nexus tools` returns schemas, never data.
- One open vault is used automatically; if several are open, run `nexus vaults`
  and pass `--vault <name>` (or set `NEXUS_VAULT`). On Windows auto-detection is
  not available — always pass `--vault <name>` (the vault folder's name).

This applies to the user's Obsidian vault, not files in the current code
repository — use normal file tools for those.
