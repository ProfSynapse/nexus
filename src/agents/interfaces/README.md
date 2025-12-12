# `src/agents/interfaces`

Shared interfaces for the agent/mode tool layer.

## What's Here

- Agent abstractions (`IAgent`) and mode abstractions (`IMode`) used by:
  - `src/agents/baseAgent.ts`
  - `src/agents/baseMode.ts`
  - concrete agents and modes under `src/agents/*`

## Improvement Ideas

- Keep interfaces aligned with the *actual* execution contract (canonical tool-call shape).
- Prefer shared types in `src/types/` for payloads to avoid circular imports.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
