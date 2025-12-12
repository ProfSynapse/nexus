# `src/agents/contentManager/modes`

## Purpose
Mode implementations (individual tools) for agent "contentManager".

## What's Here
- Subfolders: `batch`
- Files: `appendContentMode.ts`, `batchContentMode.ts`, `createContentMode.ts`, `deleteContentMode.ts`, `findReplaceContentMode.ts`, `index.ts`, `prependContentMode.ts`, `readContentMode.ts`, `replaceByLineMode.ts`, `replaceContentMode.ts`

## Improvement Ideas
- Tighten mode parameter typing and reduce `any` at the tool boundary.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
