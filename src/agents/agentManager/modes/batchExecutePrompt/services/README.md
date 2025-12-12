# `src/agents/agentManager/modes/batchExecutePrompt/services`

## Purpose
Internal services supporting agent "agentManager" modes.

## What's Here
- Subfolders: _None_
- Files: `ActionExecutor.ts`, `BudgetValidator.ts`, `ContextBuilder.ts`, `index.ts`, `PromptExecutor.ts`, `RequestExecutor.ts`, `ResultProcessor.ts`, `SequenceManager.ts`

## Improvement Ideas
- Tighten mode parameter typing and reduce `any` at the tool boundary.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
