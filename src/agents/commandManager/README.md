# `src/agents/commandManager`

Obsidian command bridge: exposes selected Obsidian commands as MCP-callable operations.

## What's Here

- `modes/` — tools like listing available commands and executing a command by ID.

## Improvement Ideas

- Validate command IDs carefully and maintain an allowlist/denylist if needed.
- Ensure command execution results are consistently shaped for tracing/UI display.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
