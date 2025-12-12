# `src/agents/agentManager`

Agent/prompt management: custom prompts, execution helpers, and prompt batch tooling.

## What's Here

- `services/CustomPromptStorageService.ts` — persistence for user-defined/custom prompts.
- `modes/` — tools for prompt CRUD and execution (including batching).

## Improvement Ideas

- Keep storage/persistence boundaries clear (agent calls service; service owns IO details).
- If batch execution grows, consider extracting a shared “batch runner” utility used across agents.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
