# `src/agents/vaultManager/modes`

## Purpose
Mode implementations (individual tools) for agent "vaultManager".

## What's Here
- Subfolders: _None_
- Files: `baseDirectoryMode.ts`, `createFolderMode.ts`, `deleteFolderMode.ts`, `deleteNoteMode.ts`, `duplicateNoteMode.ts`, `editFolderMode.ts`, `index.ts`, `listDirectoryMode.ts`, `moveFolderMode.ts`, `moveNoteMode.ts`, `openNoteMode.ts`

## Improvement Ideas
- Tighten mode parameter typing and reduce `any` at the tool boundary.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
