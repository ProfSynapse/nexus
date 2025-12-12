# `src/utils`

Shared utilities used across agents, services, server, and UI (schema helpers, validation, context normalization, and small framework glue).

## What's Here

- Schema + validation: `schemaUtils.ts`, `validationUtils.ts`
- Context/session helpers: `contextUtils.ts`, `sessionUtils.ts`, `workspaceUtils.ts`
- Tool identity helpers: [`toolNameUtils.ts`](./toolNameUtils.ts) (UI display formatting + canonical parsing via `parseAgentToolName(...)` / `resolveAgentMode(...)`)
- Paths/files: `pathUtils.ts`, `vaultUtils.ts`, `directoryTreeUtils.ts`
- Logging/errors: `logger.ts`, `errorUtils.ts`

## Improvement Ideas

- Avoid catch-all growth: promote stable subsystems into named modules (or services) instead of piling into `utils/`.
- Consolidate duplicated context/workspace parsing into one canonical helper.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
