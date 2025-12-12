# `src/agents`

The “tool layer”: domain agents and their modes (capabilities) exposed to MCP callers.

## How It Works

- **Agent** = a domain boundary (content, vault filesystem, search, memory, prompts, commands).
- **Mode** = an individual operation/tool under that agent.
- Shared bases:
  - `baseAgent.ts` — mode registry + execution helpers.
  - `baseMode.ts` — schema merging, result helpers, validation utilities.
  - `interfaces/` — shared `IAgent` / `IMode` abstractions.

## Agents

- `contentManager/` — note content operations (read/write/edit/batch).
- `vaultManager/` — filesystem-level operations (folders/files).
- `vaultLibrarian/` — search and retrieval.
- `memoryManager/` — workspaces/sessions/state snapshots/traces.
- `agentManager/` — custom prompts and prompt execution helpers.
- `commandManager/` — bridges to Obsidian command execution.

## Improvement Ideas

- Tighten mode parameter/result typing to reduce runtime validation burden.
- Keep “agent vs service” boundaries crisp: push shared logic into `services/` where it doesn’t belong to a domain.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
