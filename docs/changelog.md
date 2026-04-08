# Nexus Changelog

## April 2026

**Apr 8**: v5.7.0 — Plugin-Scoped Storage Migration, Mobile Support, Major Refactors

> **Note**: Mobile support is experimental and may have bugs.

**Plugin-Scoped Storage Migration** (commit 52185ae9)
- Storage moved from `.nexus/` to `.obsidian/plugins/<plugin-folder>/data/` — enables Obsidian Sync across devices
- Automatic migration on first launch: copies JSONL data from `.nexus/` to plugin data dir; `.nexus/` kept as read-only fallback, never deleted
- JSONLWriter supports multiple read roots for cross-device sync discovery
- "Nexus: Refresh synced data" command for mobile users whose vault syncs after init
- Two-stage migration with cache.db path routing (commit 5a2bd087)
- Race condition fix, migration perf improvements, conversation delete sync (commit e088e513)

**Mobile Support (Experimental)** (PRs #102, #103, #111)
- PR #102: Fixed crash-on-launch on iOS/Android — Node.js built-ins don't exist on Obsidian mobile
- Created `desktopRequire()` utility at `src/utils/desktopRequire.ts` for lazy module loading
- Converted 15 files from top-level imports to dynamic `import()` / lazy `require()`
- Replaced Node.js `EventEmitter` with Obsidian's cross-platform `Events` class
- PR #103: Removed `node:stream` import from mobile streaming fallback
- PR #111: Fixed CORS error when loading Node.js modules in Electron renderer
- Desktop-only features (OAuth, CLI, MCP transports, ingestion, composer, web tools, semantic search) gracefully skip on mobile
- Native chat works on mobile; MCP, local providers, and semantic search remain desktop-only

**Major Refactors** (all files brought below 600-line threshold)
- PR #119: ChatView (1120+ lines) split into 4 coordinators: ChatSessionCoordinator, ChatSendCoordinator, ChatBranchViewCoordinator, ChatSubagentIntegration
- PR #113: SQLiteCacheManager split into 6 focused collaborators
- PR #112: ModelAgentManager split into 5 collaborators
- PR #117: TaskBoardView split into data/filter/grouping/edit/sync/renderer collaborators (1008 → 453 lines)
- PR #115: MessageBubble split with branch/streaming/image helpers
- All refactors include unit coverage; public APIs preserved

**Fixes**
- PR #107: Removed context guard that blocked workspace selection in chat settings
- PR #114: Fixed type errors in WorkflowRunService and ModelAgentManager
- PR #118: Fixed SQLite WASM alias resolution in production builds
- Task board page scrolling restored (commit b1ebd58c)
- Embedding init now awaits storage adapter ready (commit 88a0cf49)

**Provider Updates** (PR #119)
- Perplexity adapter reworked with updated model support and pricing
- HybridStorageAdapter conversation list fixes
- ToolContinuationService refactor with ToolSchemaSupport extraction

**Apr 6**: v5.6.9 — Conversation list pagination + search (PR #99)
- "Load More" pagination for conversation sidebar with true database OFFSET/LIMIT
- FTS title search in sidebar for filtering conversations
- 63 new tests

**Apr 6**: v5.6.8 — Chat UI bug fixes (PR #98)
- 13 chat UI fixes from PR #97 audit: click-blocking invisible pill, text not selectable, branch copy returning wrong content, input auto-resize, tool accordion, and more
- Dead code removal

**Apr 5**: v5.6.7 — Multi-provider transcription + task board fixes (PRs #95, #96)
- Shared `TranscriptionService` layer with 5 providers / 7 models: OpenAI (Whisper, GPT-4o Transcribe), Groq, Mistral (Voxtral), Deepgram, AssemblyAI
- Task board fixes #92–#94

**Apr 2**: v5.6.6 — CustomPromptStorageService dual-write fix (PR #89, issue #88)
- Removed early returns that skipped `data.json` write after SQLite ops, preventing prompt loss on restart

**Apr 1**: v5.6.5 — Plugin store compliance (PR #87)
- Resolved all ~190 obsidian-releases bot lint violations for plugin store submission

**Apr 1**: v5.6.4 — Type safety + linting (PR #86)
- `any` → `unknown` type migration across codebase
- ESLint v9 upgrade + obsidianmd community linter integration

## March 2026

**Mar 29**: v5.6.3 — DOCX, PPTX, XLSX ingestion support

**Mar 29**: v5.6.2 — Vault ingestion modes, PDF.js fix

**Mar 29**: v5.6.1 — Ingestion multi-provider, app UX fixes, Mistral multi-turn
- **Ingestion**: `IngestModelCatalog` + `IngestCapabilityService` — explicit catalog of OCR/transcription models; UI now shows provider+model dropdowns; supports OpenAI (Whisper, GPT-4o Transcribe), Groq (Whisper), Google Gemini multimodal audio, OpenRouter (Mistral OCR, Gemini); `enableIngestion` toggle in settings
- **App UX**: `AppManager` refactored — config is source of truth; apps install as disabled (credentials first); `BaseAppAgent.supportsValidation()` + `getValidationActionLabel()`; `AppsTab` shows real manifest descriptions
- **Mistral**: passes `conversationHistory` for multi-turn; `supportsImages: true`

**Mar 29**: Web Tools Agent ✅ (PR #82)
- New `WebToolsAgent` with 5 desktop-only tools: `openWebpage`, `capturePagePdf`, `capturePagePng`, `captureToMarkdown`, `extractLinks`
- Electron BrowserWindow (`webViewer.ts`) renders pages headlessly; captures via `webContents.printToPDF()`, `capturePage()`, and DOM extraction
- `captureToMarkdown`: strips boilerplate (nav/header/footer/ads), converts HTML→Markdown via Turndown
- `extractLinks`: full link inventory with URL, text, and type (internal/external/anchor/resource)
- Desktop-only (`Platform.isDesktop` guard) — requires Electron APIs

**Mar 29**: Nexus Ingester ✅ (PR #83)
- New `IngestManagerAgent` with `ingest` + `listCapabilities` tools
- Drag PDF/audio files onto chat → confirmation modal → extraction/transcription → `.md` note alongside original
- PDF modes: text (pdfjs-dist `getTextContent()`) + vision (pdfjs-dist page render → OCR via vision API); default 20-page limit
- Audio: Whisper API via OpenAI + Groq only (Ollama/LM Studio excluded — no endpoint; Google deferred to v2)
- pdfjs-dist bundled via LoopbackPort (no worker file needed); `decodeAudioData` try-catch fallback + >25MB size guard
- VisionMessageFormatter: 4 provider families (OpenAI, Anthropic, Google, Ollama format)
- UI: IngestDropOverlay, IngestProgressBanner, IngestConfirmModal, IngestEventBinder + DefaultsTab settings
- 175 tests across 9 test files
- Plan: `docs/plans/nexus-ingester-plan.md`

**Mar 29**: Composer App ✅ (PR #81)
- New `ComposerAgent` with `compose` + `listFormats` tools following BaseAppAgent pattern
- IFormatComposer strategy pattern: markdown concat, PDF merge (pdf-lib 1.17.1), audio concat/mix (OfflineAudioContext)
- Audio output: WAV (native PCM), WebM/Opus (MediaRecorder), MP3 (wasm-media-encoders 0.7.0, MIT)
- Audio mixing: multi-track with per-track volume, offset, fadeIn/fadeOut via Web Audio API
- Security: isValidPath() path traversal prevention, aggregate file size limit (default 200MB), atomic overwrite, bounds validation
- 87 tests (7 files); pdf-lib + wasm-media-encoders pinned to exact versions

**Mar 25**: v5.5.0 — Task Board, Compaction Frontier, Tool Refactors, Provider Updates ✅ (PRs #65–72)
- **CLI providers stdin** (PR #65): Claude Code + Gemini CLI now pass prompts via stdin; Windows argv safety guard (24K limit)
- **SystemPromptBuilder refactor** (PR #66): Cleaner composition pipeline, `CompactionFrontierRecord` injection, new guide
- **Task Board UI** (PR #67): Native Obsidian kanban view (todo/in-progress/done), `openTasks` agent tool, `TaskBoardEvents` pub/sub for live refresh
- **ContextBudgetService** (PR #72): Unified context window budget tracking + compaction thresholds across all providers
- **CompactionFrontierService** (PR #68): Bounded stack of compacted context records; meta-compaction; transcript recovery; pre-send spinner in ChatInput
- **Tool display refactor** (PR #69): `toolDisplayNormalizer` + `toolDisplayFormatter` extracted from `ProgressiveToolAccordion`; structured `ToolDisplayGroup`/`ToolDisplayStep` types
- **Tool execution refactor** (PR #70): `ToolBatchExecutionService` extracted from `useTools` (430→122 lines); enriched `DirectToolExecutor` event shape
- **Provider updates** (PR #71): GPT-5.4 Mini + Nano, GitHub Copilot live model discovery, `StreamingOrchestrator` responseId persistence, `ModelDropdownRenderer` fallback fix

**Mar 23**: Claude Code Integration + Replace/Insert Tools ✅ (v5.4.0, PRs #57, #58)
- Claude Code as native chat provider: uses local Claude CLI subscription login (no API key needed)
- New `anthropic-claude-code` adapter with headless Claude Code runner and binary discovery
- Claude Code models (Haiku 4.5, Sonnet 4.6, Opus 4.6) labeled "(Claude Code)" in model dropdown
- Tool call traces and reasoning surfaced in existing chat accordions
- Replaced unified `update` tool with `replace` + `insert` tools (inspired by community PR #56)
- `replace`: validates `oldContent` at startLine/endLine, sliding-window search on mismatch
- `insert`: positional insert (N), prepend (1), append (-1)

**Mar 13**: Settings UI Redesign ✅ (PR #42)
- CSS spacing token system: 7 `--space-*` tokens (4px base), replacing ~15 hardcoded values
- New `SearchableCardManager` component: composition wrapper with search/filter + group headers
- All 4 card tabs migrated (Workspaces, Providers, Apps, Prompts) + GetStartedTab
- BreadcrumbNav: chevron icon separators, CSS specificity fix for Obsidian button defaults
- Card hover: `box-shadow` → `background-color` transition (theme-aware)
- BackButton: `div` → `button` element (keyboard accessibility)
- `CardManagerConfig.onAdd`/`addButtonText` now optional
- WorkspacesTab decomposed: 1,611 → 855 lines + WorkspaceListRenderer + WorkspaceDetailRenderer
- 132 new tests across 6 files
- Plan: `docs/plans/settings-ui-redesign-plan.md`

**Mar 8**: SDK→HTTP Migration ✅ (commit 103a9e73)
- Removed provider SDKs (OpenAI, Anthropic, Google, Groq, Mistral) — direct HTTP via shared ProviderHttpClient
- Real-time streaming via Node.js https + `processNodeStream()` (replaces buffered requestUrl approach)
- New: `ProviderHttpClient.ts` (shared HTTP + streaming + HTTPS enforcement + retry), `BufferedSSEStreamProcessor.ts`
- Fixed: Google finish reason mapping, MALFORMED_FUNCTION_CALL error surfacing, OpenAI SSE multi-line parser, Anthropic stale betas field, Mistral param names, error body truncation (security)
- 796 tests (+34 new)
- UI: ChatInput tri-state button, MessageManager interrupt-before-send

**Mar 8**: v5.1.0 Release ✅
- SDK→HTTP migration: Removed all LLM provider SDKs, direct HTTP via `ProviderHttpClient` + Obsidian `requestUrl`
- Real streaming on desktop (Node.js https), buffered fallback on mobile
- TaskManager DI wiring fixed (was never registered in runtime init path)
- Deleted unused agent factory system (`ServiceFactory.ts`, -409 lines)
- Self-documenting TaskManager tool schemas (result objects fully defined)
- Wired TaskService into MemoryManager for loadWorkspace task summaries

**Mar 8**: TaskManager Agent ✅ (PR #37)
- New agent: workspace-scoped project/task management with DAG dependencies
- Data model: Workspace → Project → Task, with `dependsOn[]` DAG edges + `parentTaskId` subtask tree
- 10 tools: createProject, listProjects, updateProject, archiveProject, createTask, listTasks, updateTask, moveTask, queryTasks, linkNote
- Services: TaskService (facade) + DAGService (pure computation: cycle detection, topological sort, next actions, blocked tasks)
- DB: 4 new tables (projects, tasks, task_dependencies, task_note_links), schema v8→v9, JSONL+SQLite hybrid
- Integration: auto-loads task summary via loadWorkspace, CacheableEntityType extended with 'project'/'task'
- 857 tests (236 new across 5 test files)
- Plan: `docs/plans/task-manager-agent-plan.md`, Architecture: `docs/architecture/task-manager-agent-architecture.md`

**Mar 4**: New Models + Bug Fixes ✅ (v4.4.5 → v4.4.6)
- Added Claude Sonnet 4.6, Gemini 3.1 Pro/Flash Lite, GPT-5.3 Chat/Codex; removed legacy Claude 4 Opus/Sonnet
- Fixed ConversationTitleModal focus trap, default temperature loading, prompt selector key, `syncWorkspacePrompt()` name vs id

## February 2026

**Feb 28**: Dynamic Image Model Defaults ✅ (v4.4.4)
- Image generation defaults now resolve from user settings instead of hardcoded values
- Priority chain: explicit param > user settings > first available provider/model > fallback
- `generateImage`: new `resolveDefaults()`, `getAvailableProviderNames()`, dynamic schema/errors
- `executeTypes`: provider optional + accepts openrouter, model widened to string

**Feb 26**: Dynamic Image Model Loading ✅ (v4.4.3)
- Image model dropdowns now load dynamically from adapters (removed hardcoded `IMAGE_MODELS`)
- `generateImage` tool schema builds model enum at runtime from configured providers

**Feb 26**: New Image Models + FLUX Validation Fix ✅ (v4.4.2)
- Added `gemini-3.1-flash-image-preview`: Google direct + OpenRouter, 512px-4K, 14 ref images
- Added `gpt-5-image` (OpenRouter only): GPT-5 with image generation, 400K context
- Fixed FLUX models (`flux-2-pro`, `flux-2-flex`) failing validation

**Feb 23**: Workspace Settings Display Fix ✅ (v4.4.1)
- Root cause: `renderWorkspacesTab()` passed stale `prefetchedWorkspaces` (populated before SQLite ready)
- Fix: pass `prefetchedWorkspaces: null` → WorkspacesTab always shows loading skeleton → awaits SQLite

**Feb 22**: Tool Call History Fix ✅ (v4.4.0)
- `MessageStreamHandler.ts` — post-loop safety net: forces `state=complete` + accumulated toolCalls
- `ConversationService.ts` — try-catch around `JSON.parse(tc.function.arguments)` in `convertToLegacyConversation`
- `MessageRepository.ts` — defensive try-catch in `rowToMessage()` for toolCallsJson/metadataJson/alternativesJson

**Feb 22**: TypeScript Build Fix ✅ (PR #31)
- `IPCTransportManager.ts` — changed socket param from `NodeJS.ReadWriteStream` to `net.Socket`

**Feb 22**: OpenAI CORS Bypass + Validation Fixes ✅ (PR #29)
- `nodeFetch.ts` — Node.js `https.request()` passed as custom `fetch` to OpenAI SDK; bypasses CORS on `/v1/responses`
- 619 tests (adds 55 nodeFetch unit tests)

**Feb 22**: Provider OAuth Connect ✅ (PR #26 — v4.3.4)
- OpenAI Codex OAuth via ChatGPT: connect button, token refresh, model listing with `(ChatGPT)` suffix
- **Codex Responses API gotchas (CRITICAL)**:
  - No `previous_response_id` support — must use stateless full input array continuation
  - `delta` is plain string, not object — `typeof event.delta === 'string'` check required
  - CORS from `app://obsidian.md` — must use Node.js `require('https').request()` not `fetch()`
  - `for await` unreliable in Electron — use explicit `chunkQueue`/`chunkWaiter` event-listener queue
  - `instructions` field always required — cannot be conditional on conversationHistory
  - Model won't use tools without `tool_choice: "auto"` + explicit tool-use preamble in instructions

**Feb 21**: IPC Transport Fix ✅ (v4.3.2)
- Fixed `handleSocketConnection` never wiring socket `close`/`end` to `transport.close()`
- FD leak on failed `connect()` also fixed (socket destroyed on rejection)

**Feb 20**: New Model Definitions ✅ (PR #22 — v4.3.1)
- Added Claude Sonnet 4.6 (`claude-sonnet-4-6`): 200K ctx, 64K out, $3/$15/M
- Added Gemini 3.1 Pro Preview (`gemini-3.1-pro-preview`): 1M ctx, 65K out, $2/$12/M

**Feb 9**: Conversation Memory Search ✅ (PR #19 — merged)
- Semantic search across conversation turns and tool call traces via `searchMemory` tool
- Two modes: Discovery (workspace-scoped) and Scoped (session-filtered, N-turn window)
- QA pair model + ContentChunker (500-char/100-overlap) + sqlite-vec KNN + multi-signal reranking
- Real-time indexing via ConversationEmbeddingWatcher + background backfill
- 351 tests pass (205 new), all coverage thresholds met
- Plan: `docs/plans/conversation-memory-search-plan.md`

**Feb 5**: Startup Performance Fix ✅ (PR #15)
- Non-blocking startup ~200ms (75x improvement from ~15s)
- Root cause: deadlock between ChatView.onOpen() and onLayoutReady

**Feb 5**: Chat Stop/Retry/Branch Bug Fixes ✅ (PR #16)
- 12 bugs fixed across stop, retry, and branch navigation
- 142 unit tests across 7 new test files

**Feb 5**: Inline AI Editing Feature ✅ (PR #14)
- Right-click or hotkey to edit selected text via LLM
- State machine pattern, streaming preview, Jest test infrastructure (41 tests)

## January 2026

**Jan 24**: ExecutePrompts improvements (optional provider/model, reference images, CommandManager cleanup)
**Jan 12**: MCP integration settings fix (invalid config handling)
**Jan 4**: CanvasManager agent (4 tools), SQLite transaction fix, memory leak fixes (7), embeddings toggle

## December 2025

**Dec 22**: Subagent UI + architecture
**Dec 20**: Auto-compaction + dual models + WebLLM
**Dec 17**: Two-Tool Architecture (95% token reduction)
**Dec 16**: Local embeddings + dead code cleanup (~4,000 lines removed)
**Dec 9**: Mobile + branching persistence
**Dec 3**: SQLite + JSONL hybrid storage
