<!-- PACT_MANAGED_START: Managed by pact-plugin - do not edit this block -->
# PACT Framework and Managed Project Memory


<!-- SESSION_START -->
## Current Session
<!-- Auto-managed by session_init hook. Overwritten each session. -->
- Resume: `claude --resume d9d09db5-78e8-45ac-a02d-224004035131`
- Team: `pact-d9d09db5`
- Session dir: `/Users/jrosenbaum/.claude/pact-sessions/claudesidian-mcp/d9d09db5-78e8-45ac-a02d-224004035131`
- Plugin root: `/Users/jrosenbaum/.claude/plugins/cache/pact-marketplace/PACT/4.2.1`
- Started: 2026-05-13 14:19:02 UTC
<!-- SESSION_END -->

<!-- PACT_MEMORY_START -->
## Retrieved Context

## Pinned Context

<!-- pinned: 2026-04-20 -->
### Line endings: LF canonical via `.gitattributes` (as of v5.8.2 / PR #169)
Repo has `.gitattributes` declaring LF canonical across `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs`/`.json`/`.md`/`.css`/`.html`/`.yml`/`.sh` + binary markers for images/audio/fonts/pdfs. If you see CRLF in the tree, it's a local-editor bug — fix the editor, don't chase it with tool normalization. Never reintroduce CRLF. If 500+ files show modified with tiny `--ignore-cr-at-eol` delta, someone's editor wrote CRLF — re-run `git add --renormalize .` on that subset, don't let it land.

<!-- pinned: 2026-04-23 -->
### Dynamic ToolManager sync: deferred refactor (issue #174)
`AgentRegistrationService.syncToolManagerAgent` + `ToolManagerAgent.registerDynamicAgent/unregisterDynamicAgent` is a callback-wrap bridge that keeps `getTools` discovery in sync when `AppManager` installs/uninstalls app agents at runtime (v5.8.4). Works today because `AppManager` is the only dynamic registrar. **Does not compose** for a second one. When a remote-MCP loader / plugin-extension agent / other dynamic registrar lands, refactor to event-based: add `onAgentRegistered`/`onAgentUnregistered` to `AgentManager`, have `ToolManagerAgent` subscribe in its constructor, delete the bridge + the `instanceof ToolManagerAgent` concrete import in `AgentRegistrationService`. Do NOT do this refactor speculatively — wait for the triggering consumer. Tracking: https://github.com/ProfSynapse/nexus/issues/174.

<!-- pinned: 2026-04-20, updated 2026-05-11 -->
### ToolManager MCP contract: CLI-first only (as of v5.8.2 / PR #170; replace migrated v5.9.0)
`useTools`/`getTools` accept ONLY top-level CLI shape: `tool` string + context fields (`workspaceId`, `sessionId`, `memory`, `goal`, `constraints?`) at top level. Legacy nested `{context: {...}, calls: [...]}` and `{request: [...]}` throw `Deprecated payload shape` at `src/agents/toolManager/services/ToolCliNormalizer.ts:444/462/495`. `UseToolParams` has no `calls`/`request` fields. `executePrompts` actions: `replace` uses 4-field pattern-anchored shape `{path, start, end, content}` (was `oldContent` + `startLine` + `endLine` + `position` pre-v5.9.0; old shape gets a clean validation error, no compat shim); `append`/`prepend` route to `insert`; `position < 1` rejected. CLI parser decodes `\uXXXX` in quoted strings.

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

### 2026-05-13 14:24
**Context**: First deliberate CLAUDE.md cleanup pass for claudesidian-mcp (Nexus) Obsidian plugin, performed 2026-05-13 in session pact-4d93b347.
**Goal**: Codify cleanup convention.
**Memory ID**: 32e138779108d9d6ffac941f4c9185cc

### 2026-05-11 21:05
**Summary**: Generalizable workflow anti-pattern surfaced during the PR #206 (pattern-anchored content replace) dogfood handoff cycle...
<!-- PACT_MEMORY_END -->

<!-- PACT_MANAGED_END -->

# Claude Code Context Document
Last Updated: 2026-05-13

## Project Overview
- **Name**: Nexus (package: claudesidian-mcp)
- **Version**: 5.9.5
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

**Current Version**: 5.9.5
Full changelog: `docs/changelog.md`

**Latest** (May 2026):
- **v5.9.0** — Pattern-anchored `content replace` (PR #206): hard schema break from `{path, oldContent, newContent, startLine, endLine}` to 4-field `{path, start, end, content}` on both `ContentManager.replace` and `executePrompts.replace`. No compat shim — old shape returns clean validation error. See the pinned ToolManager MCP contract entry for the full contract.
- **v5.8.14** — DeepSeek as first-class cloud provider (PR #205, resolves #204): direct DeepSeek API alongside other cloud providers. 4 models (`deepseek-v4-flash`/`-pro` + `-thinking` variants), thinking mode via existing `ThinkingEffortMapper`. Mobile-compatible. ⚠️ Untested in production. Known follow-up: `ProviderManager.ts` (659 LoC) and `ProvidersTab.ts` (645 LoC) crossed 600-line maintainability threshold from wiring additions; refactor when next touched.
- **v5.8.13** — Cache backend re-run loop hotfix (PR #203): fixes v5.8.12 regression on Windows. `PluginScopedStorageCoordinator.saveState` was clobbering `cacheBackend` on every boot; `runJanitor` `cache.db` delete now retries with backoff. Cross-platform fix — Mac was masking the loop via JANITOR fast-path.
- **v5.8.12** — Cloud-sync-aware cache backend (PR #202): IndexedDB on desktop (cloud-sync-immune), `vault.adapter` file backend on mobile. Foreground-blocking migration FSM on first launch. Resolves GDrive Shared Drive boot-hang. New `Nexus: Rebuild cache` command.
- **v5.8.11** — CLI tool array-bracket fix (PR #201, fixes #200): `ToolCliNormalizer` strips outer JSON-array-literal `[...]` pair on CSV-fallback when inner content fails `JSON.parse`. Fixes wikilink corruption in `content set-property --value "[[[A]],[[B]]]"`.
- **v5.8.10** — Sync-safe storage reconcile Phase 1: conflict-copy regex relax + new `ReconcilePipeline` (3-layer idempotency) + v11→v12 `shard_cursors` migration. Resolves GDrive task-revert incident. Phase 2 (cache.db relocation) was superseded by v5.8.12.

Older versions: see `docs/changelog.md`.

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

## Current Work

**Active branch**: `main`. **Open PRs**: none.

**In-flight (not yet PR'd):**
- **Canonical Message Pipeline — Phase 3**: drop redundant `LLMService.generateResponseStream` remap; accept `ConversationMessage[]` directly. ~3-5h, medium risk. Plan: `docs/plans/canonical-message-pipeline-plan.md`. Phase 1+2 shipped in PR #142. Phase 4 (single canonical message type) deferred to next-provider-add.
- **Issue #88 — CustomPromptStorageService dual-write desync**: fix committed (3447d8c5) on `fix/issue-88-dual-write-desync` worktree, awaiting PR.
- **Context Budget Service**: `feat/context-budget-service` branch, work ongoing.
- **LLM Eval Harness** (`tests/eval/`, ~3500 lines, plan in `docs/plans/llm-eval-harness-plan.md`): 27/30 pass (90%) — Sonnet 4.6 (97%), GPT 5.4-mini (94%), GPT 5.4 (77%), Gemini 3 Flash (46%). Next: headless agent stack — replace fake tool schemas with real agents on TestVault.

**Open follow-ups (deferred, not blocking):**
- `CONFLICT_COPY_PATTERNS` regex widening for Dropbox `cache (User's conflicted copy YYYY-MM-DD).db` form (closing paren before `.db` breaks the anchor).
- `waitForQueryReady` post-migration race — first-boot transient timeout papered over with sticky restart Notice in v5.8.12; root-cause investigation deferred.
- Issue #64 — Claude Code ENAMETOOLONG: PR #73 fix may not have fully resolved. Needs re-investigation.
- File Picker rootFolder leading-slash: `FilePickerRenderer.getRootFolder()` passes `/blog-test`-style paths to `getAbstractFileByPath()` which expects no leading slash. Fix: `normalizePath()` or strip leading slash.

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

- **Workspace Delete Persistence** (Feb 2): deleted workspaces may reappear on reload. Backend delete logic looks correct; suspect UI cache issue.
- **WebLLM/Nexus**: multi-turn tool continuations may crash on Apple Silicon (WebGPU issue). If startup hangs on "loading cache", clear site data.

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

**600+ line files to watch**: WorkspaceService (965), ModelAgentManager (895), SQLiteCacheManager (856), ConversationService (813), connector (731), ChatSettingsModal (702), ChatView (659), OpenRouterAdapter (640), ProviderManager (659), ProvidersTab (645), ValidationService (625), BatchExecutePromptTool (618), GoogleAdapter (612)

**Plugin store compliance**: `isDesktopOnly: false` is correct. VaultOperations uses `app.fileManager.trashFile()` (constructor takes `App` as first arg).

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

**Local-only cache** (auto-rebuilt from JSONL, never synced):
- **Desktop (v5.8.12+)**: IndexedDB-backed via `IndexedDBCacheBlobStore`. Cloud-sync-immune. First-launch migration FSM upgrades existing `cache.db` installs.
- **Mobile**: `vault.adapter` file backend via `VaultAdapterCacheBlobStore`.

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
- **Storage**: Branches as JSONL events, SQLite v12 schema (4 task tables added in v9, workflow columns in v10, archive flag in v11, `shard_cursors` added in v12), tool names use `agent_tool` format.
- **Apps & Vault Access**: App agents that produce files must have vault access wired through `BaseAppAgent`. Use `vault.createBinary()` for binary outputs (audio, images) and `vault.create()` for text. Always ensure parent directories exist before writing.
