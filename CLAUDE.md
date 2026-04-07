# Claude Code Context Document
Last Updated: 2026-04-06

## Project Overview
- **Name**: Nexus (package: claudesidian-mcp)
- **Version**: 5.6.9
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

**Current Version**: 5.6.9
Full changelog: `docs/changelog.md`

**Latest features** (Apr 2026):
- v5.6.9 (PR #99) — Conversation list pagination ("Load More") + FTS title search in sidebar
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

**PR #97 Review (Midway65)** — Community PR "Improvements to the chat panel". 37 files, +2058/-1702. Auditing in progress. UI bug fixes are legitimate; action bar feature (Insert/Append/Create File) rejected as UI noise. Schema migrations v12-v19 are fork-specific cleanup that should not be merged. Key findings:
- 3 confirmed chat UI bugs: click-blocking invisible pill, text not selectable, copy returns wrong branch content
- ProviderHttpClient timeout fix and `require()` switch are real fixes but undisclosed in PR scope
- Orphaned JSONL pruning at startup inverts JSONL-as-source-of-truth assumption — risky
- Massive whitespace noise across service/database files inflates diff

**Issue #88 — CustomPromptStorageService dual-write desync** — Fix on `fix/issue-88-dual-write-desync` branch (worktree). Committed (3447d8c5), awaiting PR.

**Issue #64 — Claude Code ENAMETOOLONG** — PR #73 fix may not have fully resolved. Needs re-investigation.

**Context Budget Service** — `feat/context-budget-service` branch, work ongoing.

**File Picker Bug** — `FilePickerRenderer.getRootFolder()` fails when workspace rootFolder has leading `/`. Separate fix needed.

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
- **Storage**: Branches as JSONL events, SQLite v11 schema (4 task tables added in v9, workflow columns in v10, archive flag in v11), tool names use `agent_tool` format.
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

<!-- pinned: 2026-04-05 -->
### Shared Transcription Infrastructure
Transcription extracted from ingest into shared service at `src/services/llm/TranscriptionService.ts`. Five providers fully integrated:
- **OpenAI** (`whisper-1`, `gpt-4o-transcribe`) — word timestamps via `verbose_json`
- **Groq** — word timestamps, fastest inference
- **Mistral** (`voxtral-mini`) — word timestamps + diarization
- **Deepgram** — word timestamps, utterances, diarization, keyword biasing
- **AssemblyAI** — word timestamps, speaker labels

Adapters at `src/services/llm/adapters/{provider}/`. Types at `src/services/llm/types/VoiceTypes.ts`.
⚠️ Ingest shim at `src/agents/ingestManager/tools/services/TranscriptionService.ts` strips word-level data — audio editor must call shared service directly.
- **Drag-drop file path**: Browser `File.name` is basename only — use `vault.getFiles().find(f => f.name === file.name)` to get vault-relative path in `handleIngestFiles`.

## Working Memory
<!-- Auto-managed by pact-memory skill. Last 3 memories shown. Full history searchable via pact-memory skill. -->

### 2026-04-06 21:10
**Context**: Orchestration retrospective for conversation list pagination and search feature (PR #99) in claudesidian-mcp v5.6.8. Full PACT cycle: plan-mode → CODE (3 tasks: backend #6, frontend #7, wiring #8) → TEST (#10, 63 tests) → REVIEW (3 reviewers: architect #12, test-engineer #13, frontend #14) → REMEDIATION (5 tasks: #16, #17, #18, #19, #20). Zero imPACT cycles. PREPARE and ARCHITECT phases skipped — plan from plan-mode was comprehensive enough. 3 blocking review findings fixed in cycle 1. Variety scored 5 (Low), actual ~6. Session completed in single pass.
**Goal**: Calibrate orchestration judgment via second-order observation — track variety scoring accuracy and dispatch strategy effectiveness for the pagination/search domain. This data feeds Learning II pattern matching for future UI pagination features.
**Decisions**: Variety scored 5 (Novelty:1, Scope:2, Uncertainty:1, Risk:1), actual ~6, Skipped PREPARE and ARCHITECT phases — plan-driven workflow, Concurrent backend + frontend CODE dispatch with planned wiring task, 3 reviewers (architect, test-engineer, frontend-coder) without security reviewer
**Lessons**: Plan-driven PREPARE/ARCHITECT skip works well for Low variety (score 5) but can miss implementation gaps like missing count() method — the plan enumerated layers to modify but did not probe whether each layer already exposed the required adapter methods. Structured gate question 3 (unknown-unknowns) should probe service method signatures more carefully., Wiring task pattern confirmed effective for 4th time (after Ingester backend+frontend, Ingester remediation, Composer) as standard approach for concurrent CODE outputs. Planning the wiring task upfront in the architecture/plan phase prevents integration surprises., Whitespace reformatting from agents pollutes diffs — the Edit tool normalizes CRLF to LF, converting every line in CRLF files. Consider adding formatting constraints to agent prompts, or requiring agents to use git checkout + sed for CRLF-sensitive files., Variety score of 5 was close to actual (~6). The count() gap was a genuine unknown-unknown that bumped Uncertainty from 1 to 2 in hindsight. For pagination features, probe adapter method availability during planning., Reviewer-to-fixer reuse (frontend-reviewer fixed blocking #17 + minor #18, test-reviewer fixed #19) is efficient — no context loss, faster than spawning fresh agents. This pattern now confirmed across 2 features (Ingester, pagination)., Concurrent remediation (5 fixers) worked cleanly — no coordination issues this time because fixes were to separate files/concerns. Sequencing was natural: blocking (#16, #17) → minor (#18, #19) → whitespace cleanup (#20).
**Reasoning chains**: Variety calibration: predicted 5 → actual ~6 (count() gap was genuine unknown-unknown, bumped Uncertainty 1→2) → scoring was accurate for pagination features with plan-mode investment → future pagination tasks can use 5-6 as baseline, PREPARE skip ROI: no PREPARE phase → 0 imPACT cycles during CODE → but 1 blocking issue caught in review (count() missing) → PREPARE investment questionable for Low variety, review caught it anyway → skip was net positive, Wiring task ROI: 1 wiring task (#8) planned upfront → clean integration of concurrent outputs → 4th confirmation of pattern → should be standard for all concurrent CODE dispatch
**Memory ID**: 91a4435063b6817f1ae45fe01c5e1dfa

### 2026-04-06 21:06
**Summary**: PR #99 peer review for conversation list pagination and search feature in claudesidian-mcp.

### 2026-04-06 20:38
**Summary**: TEST phase for conversation list pagination and search feature in claudesidian-mcp v5.6.8.
## Current Session
<!-- Auto-managed by session_init hook. Overwritten each session. -->
- Resume: `claude --resume a89883a5-9570-4c8e-a9b5-b53f8ae4ad39`
- Team: `pact-a89883a5`
- Started: 2026-04-06 20:25:34 UTC
<!-- SESSION_END -->

<!-- SESSION_START -->
## Current Session
<!-- Auto-managed by session_init hook. Overwritten each session. -->
- Resume: `claude --resume a89883a5-9570-4c8e-a9b5-b53f8ae4ad39`
- Team: `pact-a89883a5`
- Started: 2026-04-06 21:04:50 UTC
<!-- SESSION_END -->
