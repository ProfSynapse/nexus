# `src/agents/vaultLibrarian/services`

## Purpose
Internal services supporting agent "vaultLibrarian" modes.

## What's Here
- Subfolders: `formatters`
- Files: `DirectoryItemCollector.ts`, `FuzzySearchEngine.ts`, `index.ts`, `MemorySearchFilters.ts`, `MemorySearchProcessor.ts`, `ResultFormatter.ts`, `SearchFilterApplicator.ts`, `SearchResultFormatter.ts`

## Improvement Ideas
- Tighten mode parameter typing and reduce `any` at the tool boundary.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
