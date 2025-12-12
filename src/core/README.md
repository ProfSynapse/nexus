# `src/core`

## Purpose
Core plugin infrastructure (lifecycle, service management, commands, UI plumbing).

## What's Here
- Subfolders: `background`, `commands`, `services`, `settings`, `ui`
- Files: `index.ts`, `ObsidianPathManager.ts`, `PluginDataManager.ts`, `PluginLifecycleManager.ts`, `ServiceContainer.ts`, `ServiceFactory.ts`, `ServiceManager.ts`, `StructuredLogger.ts`, `VaultOperations.ts`

## Improvement Ideas
- Add a short contract note for this module (inputs/outputs, side effects).
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
