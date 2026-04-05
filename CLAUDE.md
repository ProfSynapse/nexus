# Claude Code Context Document
Last Updated: 2026-04-01

## Project Overview
- **Name**: Nexus (package: claudesidian-mcp)
- **Version**: 5.6.7
- **Type**: Obsidian Community Plugin
- **Purpose**: MCP integration for Obsidian with AI-powered vault operations
- **Architecture**: Agent-Tool pattern with domain-driven design
- **Stack**: TypeScript, Node.js, Obsidian Plugin API, MCP SDK

## Obsidian Plugin Development Guidelines

Full guidelines: `docs/obsidian-plugin-guidelines.md`

**Non-negotiable rules:**
- All styles in `styles.css`, never inline
- `innerHTML` forbidden with dynamic content — use `createEl()` / `.textContent`
- `registerDomEvent` for all DOM events (not `addEventListener` — causes memory leaks)
- Use `requestUrl()` not `fetch()` for HTTP; `normalizePath()` for paths
- Hidden files (`.nexus/`) are the only valid exception to `vault.adapter` usage

## Recent Changes

**Current Version**: 5.6.6 — fix CustomPromptStorageService dual-write desync
Full changelog: `docs/changelog.md`

**Latest features** (Apr 2026):
- v5.6.4 (PR #86) — any→unknown type migration, ESLint v9 + obsidianmd linter, Anthropic multi-tool fix
- v5.6.3 — DOCX/PPTX/XLSX ingestion support
- v5.6.0 — Nexus Ingester, Web Tools Agent, Composer App (PRs #81–83)
- v5.5.0 — Task Board, Compaction Frontier, Tool Refactors (PRs #65–72)

## Quick Navigation

### Core Directories
- `/src/agents/` - Agent implementations (PromptManager, ContentManager, etc.)
- `/src/services/` - Shared services (LLM providers, memory, conversations)
- `/src/components/` - UI components (chat view, settings, modals)
- `/src/types/` - TypeScript type definitions
- `/src/utils/` - Utility functions and helpers

### Key Files
- `main.ts` - Plugin entry point and lifecycle management
- `connector.ts` - MCP server connector for Claude Desktop
- `src/agents/index.ts` - Agent registry and initialization
- `src/services/conversationService.ts` - Chat conversation management
- `src/services/llmService.ts` - LLM provider abstraction layer

## Agent Architecture

### Available Agents

**ToolManager** (`src/agents/toolManager/`) - **MCP Entry Point** (Two-Tool Architecture)
   - `getTools`: Discovery - returns tool schemas for requested agents/tools
   - `useTools`: Execution - unified context-first tool execution
   - *Only these 2 tools are exposed to Claude Desktop. All other agents work internally.*

1. **PromptManager** (`src/agents/promptManager/`) - Custom prompts and LLM integration
   - Tools: listModels, executePrompts, createPrompt, updatePrompt, deletePrompt, listPrompts, getPrompt, generateImage

2. **ContentManager** (`src/agents/contentManager/`) - Note reading/editing operations
   - Tools: read, write, replace, insert, setProperty

3. **StorageManager** (`src/agents/storageManager/`) - File/folder management
   - Tools: list, createFolder, move, copy, archive, open

4. **SearchManager** (`src/agents/searchManager/`) - Advanced search operations
   - Tools: searchContent, searchDirectory, searchMemory

5. **MemoryManager** (`src/agents/memoryManager/`) - Session/workspace/state management
   - Tools: createSession, loadSession, createWorkspace, createState, etc.

6. **CanvasManager** (`src/agents/canvasManager/`) - Obsidian canvas operations
   - Tools: read, write, update, list

7. **TaskManager** (`src/agents/taskManager/`) - Workspace-scoped project/task management with DAG dependencies
   - Tools: createProject, listProjects, updateProject, archiveProject, createTask, listTasks, updateTask, moveTask, queryTasks, linkNote
   - Services: TaskService (business facade), DAGService (pure computation)
   - Auto-loads task summary when workspace loads

8. **IngestManager** (`src/agents/ingestManager/`) - PDF/audio ingestion
   - Tools: ingest, listCapabilities

9. **WebToolsAgent** (`src/agents/apps/webTools/`) - Headless browser tools (desktop-only)
   - Tools: openWebpage, capturePagePdf, capturePagePng, captureToMarkdown, extractLinks

10. **ComposerAgent** (`src/agents/apps/composer/`) - Multimodal file composition
    - Tools: compose, listFormats

### Agent Structure Pattern
```
agents/
  [agentName]/
    [agentName].ts          # Main agent class extending BaseAgent
    tools/                   # Operation tools
      [toolName].ts
      services/             # Tool-specific services
    services/               # Agent-level shared services
    types.ts
    utils/
```

### Base Classes
- **BaseAgent** (`src/agents/baseAgent.ts`) - Common agent functionality
- **BaseTool** (`src/agents/baseTool.ts`) - Common tool functionality with generic types
- **IAgent** (`src/agents/interfaces/IAgent.ts`) - Agent interface contract
- **ITool** (`src/agents/interfaces/ITool.ts`) - Tool interface contract

## Current Context

### Active Branch
`main`

### Open PRs
None.

### Current Work

**`any` → `unknown` Type Migration** ✅ — Complete. TS build passes (exit 0), lint clean (0 violations). 539 files changed. 8 test suites still failing (73 tests) — user fixing manually. Remaining test failures: `QAPairBuilder`, `BranchManager`, `ComposeTool`, `MessageAlternativeService`, `ClaudeHeadlessService`, `GoogleGeminiCliAdapter`, `AnthropicClaudeCodeAdapter`, `cliProcessRunner`.

**ESLint v9 + Obsidian plugin linter** ✅ — Upgraded to ESLint v9 + typescript-eslint v8 + `eslint-plugin-obsidianmd`. Flat config at `eslint.config.mjs`. Config updated for obsidian-releases bot parity: `require-await` enabled, `prefer-file-manager-trash-file` escalated to error, Node.js imports exempted at config level, sentence-case configured with project acronyms/brands. Lint passes clean (0 errors, 0 warnings). All ~190 bot violations fixed on `fix/pr-bot-lint` branch (135 files).

**Anthropic multi-tool-call regression** ✅ fixed — Added `index?: number` to `ToolCall` interface (`src/services/llm/adapters/types.ts`), restored `index: event.index` to both `extractToolCalls` return objects in `AnthropicAdapter.ts`. SSEStreamProcessor accumulation now works correctly for multi-tool responses.

**Issue #88 — CustomPromptStorageService dual-write desync** — Fix on `fix/issue-88-dual-write-desync` branch (worktree). Removed early returns in createPrompt/updatePrompt/deletePrompt so both SQLite and data.json are always written. Committed (3447d8c5), awaiting PR.

**Issue #64 — Claude Code ENAMETOOLONG** — User reports PR #73 fix may not have fully resolved the issue. Needs re-investigation.

**Context Budget Service** — `feat/context-budget-service` branch is the user's active in-progress branch. Work ongoing.

**File Picker Bug** — `FilePickerRenderer.getRootFolder()` fails when workspace rootFolder has leading `/` (e.g., `/blog-test` → Obsidian expects `blog-test`). Separate fix needed.

### Branch Architecture

A branch IS a conversation with parent metadata:
- `metadata.parentConversationId`: parent conversation
- `metadata.parentMessageId`: message the branch is attached to
- `metadata.branchType`: 'alternative' | 'subagent'

**Key Files**:
- `src/services/chat/BranchService.ts` - Facade over ConversationService
- `src/ui/chat/controllers/SubagentController.ts` - Subagent infrastructure
- `src/ui/chat/controllers/NexusLoadingController.ts` - Loading overlays
- `src/ui/chat/services/ContextTracker.ts` - Token/cost tracking

### Known Issues

**Task Board: No JSONL→SQLite sync for tasks** (Mar 26 — fix in progress, branch `fix/task-board-sync`):
- Fix implemented: `TaskEventApplier.ts` (new), `SyncCoordinator.rebuildTasks()`, `clearAllData()` now clears task tables, `reconcileMissingTasks()` in HybridStorageAdapter, workspace name→UUID resolution in TaskService
- Workspace name resolution: `createProject`/`createTask` now accept workspace names and silently resolve to UUID; ambiguous names fail with nudge listing all UUIDs
- **Do NOT recommend deleting `cache.db`** — task tables are not rebuilt from JSONL (this PR fixes that, but until released, don't delete)

**File Picker rootFolder Leading Slash** (Mar 13):
- `FilePickerRenderer.getRootFolder()` passes workspace rootFolder (e.g., `/blog-test`) directly to `getAbstractFileByPath()`, which expects no leading slash
- Shows "Folder not found" for valid folders. Fix: `normalizePath(this.rootPath)` or strip leading slash

**Workspace Delete Persistence** (Feb 2):
- Deleted workspaces may reappear on page reload. Backend delete logic looks correct, may be UI cache issue.

**Subagent Flow** (Dec 22, fixed Feb 20 in `fix/subagent-bugs` — awaiting manual test):
- 29 bugs fixed. Full fix list: `docs/review/pr23-subagent-functionality-review.md`

**WebLLM/Nexus** (Dec 20):
- Multi-turn tool continuations may crash on Apple Silicon (WebGPU issue)
- If startup hangs on "loading cache", clear site data

## Development Notes

### Build Commands
- `npm run dev` - Development build with watch mode
- `npm run build` - Production build (TypeScript + esbuild)
- `npm run test` - Run Jest test suite
- `npm run lint` - Run ESLint
- `npm run deploy` - Build and deploy via PowerShell script
- **Release**: Use `/nexus-release` skill for version bumping and GitHub release creation

### Testing Approach
- **Unit Tests**: Jest for core logic and services (1200+ tests)
- **Integration Tests**: Manual testing in Obsidian environment
- **MCP Testing**: Via Claude Desktop connection

### Code Patterns

- **Agents**: Extend `BaseAgent`, register tools in constructor
- **Tools**: Extend `BaseTool<Params, Result>`, implement `execute()`, `getParameterSchema()`, `getResultSchema()`
- **Results**: Return `{ success: boolean, ...data }` or `{ success: false, error: string }`
- **Services**: Singletons with dependency injection via constructor
- **Adding a new agent**: (1) Add `initializeYourAgent()` to `AgentInitializationService.ts`, (2) Add `safeInitialize('yourAgent', ...)` to a phase in `AgentRegistrationService.doInitializeAllAgents()`. No factory classes, no ServiceDefinitions entry.

### Dependencies
See `package.json`. Key: MCP SDK, express, winston, uuid. LLM provider SDKs removed — direct HTTP via ProviderHttpClient.

## Code Quality

Full tech debt tracker: `docs/tech-debt.md`

**600+ line files to watch**: WorkspaceService (965), ModelAgentManager (895), SQLiteCacheManager (856), ConversationService (813), connector (731), ChatSettingsModal (702), ChatView (659), OpenRouterAdapter (640), ValidationService (625), BatchExecutePromptTool (618), GoogleAdapter (612)

**Plugin store compliance**: `isDesktopOnly: false` is correct. PR #11597 to obsidian-releases — all ~190 bot violations fixed on `fix/pr-bot-lint`. Audited GREEN. VaultOperations now uses `app.fileManager.trashFile()` (constructor takes `App` as first arg).

## MCP Integration

### Server Configuration
- Server runs locally via `connector.js`
- Configured in Claude Desktop's `claude_desktop_config.json`
- Server identifier: `claudesidian-mcp-[vault-name]`
- Supports multiple vault instances simultaneously

### Two-Tool Architecture

Instead of 50+ tools, MCP exposes just 2: `getTools` (discovery) and `useTools` (execution).

**Context Schema**: `{ workspaceId, sessionId, memory, goal, constraints? }` - all required except constraints.

**Flow**: `getTools` → get schemas → `useTools` with context + calls array

**Benefits**: 95% token reduction (~15,000 → ~500), works with small context models.

**Key Files**: `src/agents/toolManager/` (agent + tools), `src/services/trace/ToolCallTraceService.ts`

**Tool Count**: 55 tools across 8 agents (not counting ToolManager meta-tools)

## Memory & Workspace System

### Storage Location
`.nexus/` - All storage in single hidden folder:
- `conversations/*.jsonl` - OpenAI fine-tuning format (syncs across devices)
- `workspaces/*.jsonl` - Event-sourced workspace data
- `tasks/tasks_[workspaceId].jsonl` - Task/project events per workspace
- `cache.db` - SQLite local cache (auto-rebuilt, not synced) ⚠️ **Do NOT delete** — task/project data is NOT recovered from JSONL on rebuild

### Architecture
- Hybrid JSONL + SQLite: JSONL = source of truth, SQLite = fast queries
- True database pagination with OFFSET/LIMIT
- Workspace-scoped sessions and traces
- Searchable via MemoryManager and SearchManager agents

## UI Components

- **Chat View**: `src/components/ChatView.ts` - conversations, branching, streaming, tool accordion
- **Settings**: `src/components/ConfigModal.ts` - tabbed LLM/agent configuration

### Chat Suggesters
| Trigger | Purpose |
|---------|---------|
| `/` | Tool hints |
| `@` | Custom agents |
| `[[` | Note links |
| `#` | Workspace data |

Key files: `src/ui/chat/components/suggesters/`, `MessageEnhancer.ts`, `SystemPromptBuilder.ts`

## Architectural Notes

- **Subagents**: Branch → stream via LLMService → save result. `chunk.toolCalls` are display-only.
- **WebLLM/Nexus**: Nexus Quark (4B, 4K context), `<tool_call>` format. May crash on Apple Silicon.
- **Storage**: Branches as JSONL events, SQLite v9 schema (4 task tables added in v9), tool names use `agent_tool` format.
- **Apps & Vault Access**: App agents that produce files must have vault access wired through `BaseAppAgent`. Use `vault.createBinary()` for binary outputs (audio, images) and `vault.create()` for text. Always ensure parent directories exist before writing.

## Pinned Context

<!-- pinned: 2026-03-29 -->
### pdfjs-dist in Obsidian/Electron (legacy build + shared loader)
PDF.js 5 expects a configured `workerSrc` in the Electron renderer. Use the legacy build with a shared loader that seeds `globalThis.pdfjsWorker`:
```typescript
// src/agents/ingestManager/tools/services/PdfJsLoader.ts
const [pdfjsLib, pdfjsWorker] = await Promise.all([
  import('pdfjs-dist/legacy/build/pdf.mjs'),
  import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
]);
if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = pdfjsWorker;
```
Use `loadPdfJs()` from `PdfJsLoader.ts` in both `PdfTextExtractor.ts` and `PdfPageRenderer.ts`. Do NOT use `import('pdfjs-dist')` directly — the main entry fails in Electron without a worker URL.

<!-- pinned: 2026-03-29 -->
### IngestManagerAgent — audio transcription provider scope (v1)
Whisper API (OpenAI + Groq) only. Excluded in v1:
- **Ollama / LM Studio**: No audio transcription endpoint — vision-only
- **Google multimodal audio**: Deferred to v2 (requires different API path)
- **Drag-drop file path**: Browser `File.name` is basename only — use `vault.getFiles().find(f => f.name === file.name)` to get vault-relative path in `handleIngestFiles`.

## Working Memory
<!-- Auto-managed by pact-memory skill. Last 3 memories shown. Full history searchable via pact-memory skill. -->

### 2026-03-29 18:54
**Context**: Orchestration retrospective for the Nexus Ingester feature in claudesidian-mcp. Full PACT cycle: PREPARE, concurrent CODE (backend + frontend), TEST, REVIEW (5 reviewers), REMEDIATION (3 concurrent fixers). PR #83 on feat/nexus-ingester branch. Variety scored 13 (Novelty:3, Scope:4, Uncertainty:3, Risk:3). Zero imPACT cycles triggered. All phases completed on first pass. 16 specialist tasks total across the workflow. The orchestration pattern was: sequential phases with concurrent specialists within each phase, plus a planned follow-up wiring task to bridge concurrent CODE outputs.
**Goal**: Calibrate orchestration judgment via second-order observation -- track variety scoring accuracy and dispatch strategy effectiveness for the ingester domain. This data feeds Learning II pattern matching for future new-agent implementations.
**Decisions**: Variety scored 13 (Novelty:3, Scope:4, Uncertainty:3, Risk:3), actual was close -- zero imPACT cycles, Concurrent frontend+backend CODE dispatch with planned wiring task, Concurrent remediation dispatch (3 fixers in parallel) with test-reviewer reuse
**Lessons**: Concurrent agent dispatch consistently produces shared constant duplication (DRY findings in review) -- consider injecting shared constants explicitly in dispatch prompts for cross-domain parallel work. The ingester had ACCEPTED_EXTENSIONS duplicated 4x and provider lists duplicated in ChatView and DefaultsTab., PREPARE phase investment pays off: pdfjs-dist LoopbackPort approach and decodeAudioData crash risk identified upfront prevented blocking issues during CODE. Without PREPARE, these would have been imPACT-triggering blockers., Reviewer reuse as fixer (test-reviewer stayed for test alignment fixes after review) is efficient -- no context loss. The reviewer already understood the codebase and the issues, so fixing was faster than spawning a fresh agent., Variety score of 13 was accurate -- actual difficulty matched prediction. Zero imPACT cycles, all phases ran as planned. The high Scope dimension (4) was justified by the cross-cutting nature (new agent + adapter extensions + UI + settings + tests)., Concurrent remediation dispatch caused test/implementation alignment gap: TranscriptionService error format and AudioChunkingService >25MB behavior were changed by backend fixer but tests were written against the pre-fix behavior. Resolved by reusing test-reviewer to align tests with fixes. For future concurrent remediation, consider sequencing test updates after implementation fixes., The wiring task pattern (task #14) for bridging concurrent CODE outputs worked well and was planned upfront. This should be the standard pattern when frontend and backend are dispatched concurrently with a shared integration point.
**Reasoning chains**: Variety calibration: predicted 13 -> actual ~13 (no imPACTs, no phase reruns) -> scoring was accurate for new-agent implementations with PREPARE investment -> future new-agent tasks in this project can use 12-14 as baseline variety, DRY duplication from concurrent dispatch: parallel agents independently define same constants -> review catches it -> remediation consolidates -> prevention: inject shared constants in dispatch prompts or define types.ts contents upfront in architecture phase, PREPARE ROI: 1 preparer task upfront -> 0 imPACT cycles during CODE -> saved at least 2 potential blockers (pdfjs-dist bundling, decodeAudioData crash) -> PREPARE is justified for variety 10+ tasks
**Memory ID**: 6ecbd511caced58995c91472df49c955

### 2026-03-29 18:46
**Summary**: Post-review remediation for Nexus Ingester PR #83 in claudesidian-mcp.

### 2026-03-29 16:10
**Summary**: Completed full PACT cycle (PREPARE → CODE → TEST → REVIEW in progress) for the Nexus Ingester feature in claudesidian-mc...
## Current Session
<!-- Auto-managed by session_init hook. Overwritten each session. -->
- Resume: `claude --resume 53b8cd78-df63-4a32-b113-132dde8d14df`
- Team: `pact-53b8cd78`
- Started: 2026-03-29 13:26:59 UTC
<!-- SESSION_END -->

<!-- SESSION_START -->
## Current Session
<!-- Auto-managed by session_init hook. Overwritten each session. -->
- Resume: `claude --resume 0d94f9cc-e1c7-415d-bfa6-a807f6ff6252`
- Team: `pact-0d94f9cc`
- Started: 2026-04-02 23:23:08 UTC
<!-- SESSION_END -->
