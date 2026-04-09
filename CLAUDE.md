# Claude Code Context Document
Last Updated: 2026-04-06

## Project Overview
- **Name**: Nexus (package: claudesidian-mcp)
- **Version**: 5.7.2
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

### Mobile Compatibility (Critical)

**`isDesktopOnly: false`** — this plugin runs on mobile. Node.js built-ins (`fs`, `path`, `http`, `crypto`, `events`, `stream`, `net`, `os`, `url`, `process`, `buffer`) do NOT exist on Obsidian mobile.

**Top-level imports execute during module init, BEFORE any `Platform.isDesktop` guard can run.** This means:

| Pattern | Result on Mobile |
|---------|-----------------|
| `import mammoth from 'mammoth'` (top-level) | **Crashes plugin** — mammoth depends on `stream`, `fs` |
| `import { EventEmitter } from 'events'` (top-level) | **Crashes plugin** — null on mobile |
| `const mammoth = await import('mammoth')` (inside async fn) | **Safe** — only loads when called |
| `const fs = desktopRequire<typeof import('node:fs')>('node:fs')` (inside fn) | **Safe** — lazy load |

**Rules for new code:**
1. **Never** top-level import Node.js built-ins — use `desktopRequire()` from `src/utils/desktopRequire.ts`
2. **Never** top-level import npm packages that depend on Node.js built-ins (mammoth, jszip, xlsx, yaml, etc.) — use dynamic `await import()` inside async functions
3. **Replace** `EventEmitter` with Obsidian's `Events` class (cross-platform)
4. **Desktop-only features** (ingestion, composer, OAuth, CLI, MCP transports): ensure all Node.js-dependent imports are lazy

**Known desktop-only npm packages**: mammoth, jszip, xlsx, yaml (all have Node.js transitive deps)

## Recent Changes

**Current Version**: 5.7.2
Full changelog: `docs/changelog.md`

**Latest features** (Apr 2026):
- v5.7.1 — Claude Code desktop auth status/login fix for Electron renderer imports (issue #120)
- v5.7.0 — Plugin-scoped storage migration, mobile support (experimental), major refactors (PRs #102–#119)
- v5.6.9 (PR #99) — Conversation list pagination ("Load More") + FTS title search in sidebar
- v5.6.4 (PR #86) — any→unknown type migration, ESLint v9 + obsidianmd linter, Anthropic multi-tool fix
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

**Primary (synced)**: `.obsidian/plugins/<plugin-folder>/data/` — plugin-scoped, included by Obsidian Sync:
- `conversations/*.jsonl` - OpenAI fine-tuning format
- `workspaces/*.jsonl` - Event-sourced workspace data
- `tasks/tasks_[workspaceId].jsonl` - Task/project events per workspace
- `migration/` - Migration manifest and verification state

**Legacy fallback**: `.nexus/` — original hidden folder, kept as read-only fallback after migration. Not deleted automatically.

**Local-only**: `cache.db` - SQLite local cache (auto-rebuilt from JSONL, never synced) ⚠️ **Do NOT delete** — task/project data is NOT recovered from JSONL on rebuild

**Migration**: On first launch, JSONL files are copied from `.nexus/` to the plugin data folder. The migration is copy-only, idempotent, and verified before the plugin switches reads to the new location. Mobile users whose vault syncs after init can run **Nexus: Refresh synced data** from the command palette.

**Path resolution**: The plugin folder name is resolved at runtime from `plugin.manifest.dir` (supports both `nexus` and legacy `claudesidian-mcp` installs). See `src/database/storage/PluginStoragePathResolver.ts`.

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

### 2026-04-06 22:09
**Context**: Fixed a critical crash-on-launch bug for Nexus (claudesidian-mcp) on Obsidian mobile. The plugin loaded fine on desktop but immediately crashed on mobile (iOS/Android) because Obsidian mobile runs in a JavaScript-only environment WITHOUT Node.js built-ins. The crash occurred during plugin initialization — before any runtime guards like Platform.isDesktop could execute — because ES module top-level imports are evaluated at module load time. This affected 14 files across settings, services, utils, server transports, and agents. The fix introduced a shared desktopRequire() utility and converted all problematic imports to dynamic import() or lazy require() patterns. This is a fundamental Obsidian plugin development constraint that applies to ALL plugins targeting both desktop and mobile.
**Goal**: Establish institutional knowledge about the 'mobile-hostile imports' pattern so that future development on claudesidian-mcp (and any Obsidian plugin work) avoids introducing top-level imports of Node.js-dependent packages, which silently work on desktop but crash on mobile.
**Decisions**: Use dynamic import() for npm packages with Node.js internals instead of top-level imports, Created shared desktopRequire() utility at src/utils/desktopRequire.ts
**Lessons**: On Obsidian mobile, Node.js built-ins do NOT exist: fs, path, http, crypto, events, stream, net, os, url, process, buffer are all unavailable. Any npm package that transitively depends on these will crash if imported at the top level during plugin initialization., ES module top-level imports execute during module initialization BEFORE any runtime guard (like Platform.isDesktop) can run. This means even code like 'if (Platform.isDesktop) { useNodeFeature() }' will crash if the import at the top of the file pulls in Node.js dependencies — the import itself fails before the guard is reached., Three categories of mobile-hostile imports were identified: (1) Direct Node.js imports in our code (e.g., import * as nodeFs from 'node:fs', import { EventEmitter } from 'events'), (2) npm packages with transitive Node.js deps (mammoth→jszip→stream/events/fs, xlsx→stream, jszip→stream/events, yaml→process/buffer), (3) Desktop-only features that should never load on mobile (OAuth server, CLI utils, MCP transports, ingestion agents, composer agent)., The fix for direct Node.js imports is to use a desktopRequire() helper that wraps globalThis.require for lazy loading, or replace with Obsidian equivalents (e.g., Node's EventEmitter → Obsidian's Events class which provides on/off/trigger)., The fix for npm packages with Node.js internals is to convert top-level 'import X from "package"' to dynamic 'await import("package")' inside async functions. This defers module loading to runtime when the feature is actually used, avoiding the crash during plugin init., A shared utility was created at src/utils/desktopRequire.ts that wraps the globalThis.require pattern for ESLint compatibility. This is the canonical way to lazily require Node.js modules in this codebase., When adding ANY new npm dependency to an Obsidian plugin, check its dependency tree for Node.js built-in usage. Tools like 'npm ls' or checking the package's package.json for 'node:' imports can reveal transitive Node.js dependencies that will break mobile.
**Memory ID**: c1bc3267ec04afc02b1cb6df52f6f916

### 2026-04-06 21:10
**Summary**: Orchestration retrospective for conversation list pagination and search feature (PR #99) in claudesidian-mcp v5.6.8.

### 2026-04-06 21:06
**Summary**: PR #99 peer review for conversation list pagination and search feature in claudesidian-mcp.
## Current Session
<!-- Auto-managed by session_init hook. Overwritten each session. -->
- Resume: `claude --resume a89883a5-9570-4c8e-a9b5-b53f8ae4ad39`
- Team: `pact-a89883a5`
- Started: 2026-04-06 20:25:34 UTC
<!-- SESSION_END -->

<!-- SESSION_START -->
## Current Session
<!-- Auto-managed by session_init hook. Overwritten each session. -->
- Resume: `claude --resume c5de3df6-8deb-4276-8c92-e89422ce357f`
- Team: `pact-c5de3df6`
- Session dir: `/Users/jrosenbaum/.claude/pact-sessions/claudesidian-mcp/c5de3df6-8deb-4276-8c92-e89422ce357f`
- Plugin root: `/Users/jrosenbaum/.claude/plugins/marketplaces/pact-marketplace/pact-plugin`
- Started: 2026-04-08 11:05:59 UTC
<!-- SESSION_END -->
