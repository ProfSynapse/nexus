# `src/database/repositories/interfaces`

## Purpose
Repository implementations per entity (CRUD/query helpers).

## What's Here
- Subfolders: _None_
- Files: `IConversationRepository.ts`, `IMessageRepository.ts`, `index.ts`, `IRepository.ts`, `ISessionRepository.ts`, `IStateRepository.ts`, `ITraceRepository.ts`, `IWorkspaceRepository.ts`

## Improvement Ideas
- Keep interfaces minimal; prefer shared types where possible to reduce duplication.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
