## Nexus vault access

This machine runs Nexus (Obsidian). To read, search, or edit the user's vault —
notes, folders, canvas, tasks, memory/workspaces, saved prompts — use the
`nexus` CLI. No MCP connection is needed.

- **Discover:** `nexus tools [selector]` returns the live tool catalog. Drill
  down to the narrowest selector you need — `nexus tools storage list` gives one
  tool with its full argument schema; `nexus tools "storage list, content read"`
  grabs several at once.
- **Execute:** `nexus use "<agent action --flags>" --memory "<what you're doing>" --goal "<objective>"`.
  `--memory` and `--goal` are **required** on every `use`. Results are JSON.
- **Vault:** one open vault is used automatically; if several are open, run
  `nexus vaults` and pass `--vault <name>` (or set `NEXUS_VAULT`).
- Search/list results are **locations, not contents** — follow a hit with
  `content read --path <path>`.

Run `nexus --help` for full usage. This applies to the user's Obsidian vault,
not files in the current code repository — use normal file tools for those.
