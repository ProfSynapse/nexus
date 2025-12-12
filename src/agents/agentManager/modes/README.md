# `src/agents/agentManager/modes`

## Purpose
Mode implementations (individual tools) for agent "agentManager".

## What's Here
- Subfolders: `batchExecutePrompt`, `execute`
- Files: `createAgentMode.ts`, `deleteAgentMode.ts`, `executePromptMode.ts`, `generateImageMode.ts`, `getAgentMode.ts`, `index.ts`, `listAgentsMode.ts`, `listModelsMode.ts`, `toggleAgentMode.ts`, `updateAgentMode.ts`

## Improvement Ideas
- Tighten mode parameter typing and reduce `any` at the tool boundary.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
