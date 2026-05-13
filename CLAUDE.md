<!-- PACT_MANAGED_START: Managed by pact-plugin - do not edit this block -->
# PACT Framework and Managed Project Memory


<!-- SESSION_START -->
## Current Session
<!-- Auto-managed by session_init hook. Overwritten each session. -->
- Resume: `claude --resume bcb62e81-aa57-4349-868b-d39c4dbd8f95`
- Team: `pact-bcb62e81`
- Session dir: `/Users/jrosenbaum/.claude/pact-sessions/claudesidian-mcp/bcb62e81-aa57-4349-868b-d39c4dbd8f95`
- Plugin root: `/Users/jrosenbaum/.claude/plugins/cache/pact-marketplace/PACT/4.1.10`
- Started: 2026-05-11 20:53:38 UTC
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

### 2026-05-11 21:05
**Context**: Generalizable workflow anti-pattern surfaced during the PR #206 (pattern-anchored content replace) dogfood handoff cycle in claudesidian-mcp session pact-bcb62e81 (2026-05-11). A teammate sent a wake-signal SendMessage to the team-lead BEFORE the on-disk artifacts (staged files + metadata.handoff in task store) had been persisted. The team-lead inspected immediately on receiving the wake, saw an empty state, and issued a false-negative HANDOFF rejection. The teammate then had to recover by persisting the artifacts and re-sending. This is a generic partial-state failure mode in any handoff protocol where the inspector reacts to a notification by reading state — the wake notification is faster than the persistence it announces. Surfaced by backend-reviewer during PR #206 review and flagged for institutional capture by the team-lead in the consolidation harvest dispatch.
**Goal**: Make the artifact-race anti-pattern retrievable as a standalone workflow lesson independent of the originating PR. Future agents writing handoff code, dispatching peer reviews, or coordinating multi-step workflows should find this lesson via search on 'wake signal', 'handoff persistence', 'partial state notification', or related queries — and apply the persist-before-send ordering rule by default.
**Decisions**: Capture artifact-race as a standalone memory rather than burying inside the PR #206 memory cc3d825d, Specify the canonical 4-step ordering verbatim (stage → metadata.handoff → intentional_wait → SendMessage)
**Lessons**: Artifact-race anti-pattern: any wake-signal notification (SendMessage to a teammate or lead) MUST be the LAST step in a handoff sequence, sent only after all on-disk artifacts are persisted. The persistence-before-notification rule prevents the inspector from racing the persister and seeing partial state. Generalizes to any protocol where the inspector reads state in response to a notification., Symptom of artifact-race: false-negative HANDOFF rejection. The inspector receives the wake, reads state, sees nothing or stale state, issues a rejection. The persister then completes persistence, sees the rejection, and either retries (best case) or treats the rejection as authoritative (worst case — work is silently abandoned). Either way, a wasted round trip., Correct ordering for a dogfood handoff in PACT teams: (1) write or stage all output artifacts (git add, write to disk, save documents), (2) call TaskUpdate to write metadata.handoff with the 6-field schema (produced/decisions/reasoning_chain/uncertainty/integration/open_questions), (3) set intentional_wait{reason=awaiting_lead_*, expected_resolver=lead}, (4) ONLY THEN SendMessage the wake-signal to the lead. Steps 1-3 establish the state the lead is about to inspect; step 4 announces it., Same shape as 'git commit before git push': the notification (push) MUST follow the persistence (commit). Reviewers should recognize the structural similarity when reviewing any code that sends a notification to trigger inspection., Detection in review: when reviewing handoff or notification code, check whether the SendMessage / publish / notify call site appears AFTER all persistence calls in the source order. If a SendMessage appears before staged-file writes, write-to-disk calls, or commits, that is the artifact-race anti-pattern.
**Reasoning chains**: Wake-signal SendMessage triggers immediate inspector read → if persistence is incomplete when the inspector reads, the inspector sees partial/empty state → inspector issues false-negative rejection → persister completes after the rejection, has to recover or silently abandons → invert ordering: persistence MUST be complete before the wake-signal is sent, Same structural shape as 'commit before push' for git → push without commit is a no-op or pushes stale state → SendMessage without artifact-on-disk is the analogous failure → reviewers can apply the same heuristic to both: source-order check (notification call AFTER all persistence calls)
**Agreements**: Wake-signal SendMessage is ALWAYS the last step in a handoff sequence — after staging files, writing metadata.handoff, and setting intentional_wait, False-negative HANDOFF rejections caused by artifact-race are NOT a teammate-quality issue — they are an ordering bug in the handoff protocol; recovery is to persist, then re-send the wake
**Memory ID**: 0e7ccbed113e4d9309faa055e5da1828
<!-- PACT_MEMORY_END -->

<!-- PACT_MANAGED_END -->

# Claude Code Context Document
Last Updated: 2026-05-11

## Project Overview
- **Name**: Nexus (package: claudesidian-mcp)
- **Version**: 5.9.3
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

**Current Version**: 5.9.3
Full changelog: `docs/changelog.md`

**Latest features** (May 2026):
- v5.8.14 - **DeepSeek as first-class cloud provider** (PR #205, resolves #204): adds direct DeepSeek API support alongside OpenAI / Anthropic / Google / Mistral / Groq / OpenRouter etc. New `DeepSeekAdapter` (OpenAI-compatible REST, Bearer auth, `https://api.deepseek.com`). 4 model entries: `deepseek-v4-flash` ($0.14/$0.28 per 1M tokens, cache hit $0.0028, 1M context, 384K max output) + `deepseek-v4-pro` ($0.435/$0.87 per 1M, 75% discount until 2026-05-31, 1M context) + `-thinking` variants of each. Thinking mode plugged into existing `ThinkingEffortMapper` two-sided abstraction: input maps to DeepSeek's proprietary `thinking: {type: 'enabled', reasoning_effort: 'high'|'max'}` shape; output via `delta.reasoning_content` / `message.reasoning_content` surfaced through unified `StreamChunk.reasoning` field — chat UI renders DeepSeek reasoning blocks for free, same path as Claude / Gemini / o-series / Groq. `frequency_penalty`/`presence_penalty` stripped (DeepSeek removed support). 13 wiring touchpoints: types union, AdapterRegistry, ProviderTypes default, ProviderManager def, ValidationService, ThinkingEffortMapper (incl. interface + supportedProviders), platform.ts mobile-compatible list, ModelDropdownRenderer, ProviderUtils (display name, color #4d6bfe, emoji 🐋, abbreviation DSK, streaming/functions/JSON lists), ProvidersTab + cloudIds, VisionMessageFormatter, ingestTool labels. Mobile-compatible (requestUrl REST). 18/18 new tests green, `tsc --noEmit` clean. ⚠️ **Untested in production** — author does not use DeepSeek; users requested via #204. Known follow-up: `ProviderManager.ts` (659 LoC) and `ProvidersTab.ts` (645 LoC) crossed 600-line maintainability threshold from wiring additions; refactor when next touched.
- v5.8.13 - **Cache backend re-run loop hotfix** (PR #203): fixes a v5.8.12 regression discovered post-deploy on Windows. Root cause: `PluginScopedStorageCoordinator.saveState` was unconditionally replacing `pluginData.pluginStorage` on every boot during `prepareStoragePlan`, clobbering the `cacheBackend: { backend: 'idb', migrationState: 'verified' }` field that `CacheBackendMigration.runIfNeeded` had just persisted. macOS hid the loop because JANITOR's fire-and-forget `cache.db` delete succeeded → next boot's `legacyExists` returned false → fresh-install fast-path. Windows JANITOR's single-shot `adapter.remove` failed (Obsidian filesystem watcher holds a transient handle on plugin files) → `legacyExists` stayed true → full FSM re-ran every boot. Two fixes: (1) `saveState` now merges existing `cacheBackend` into the new `pluginStorage` object before `saveData` (`writeCacheBackendState` was already correct via `pluginDataLock`; this brings `saveState` into line); (2) `runJanitor` retries the literal `cache.db` delete with 100/250/500 ms backoff (3 attempts, 850 ms total budget). Conflict-copy siblings stay one-shot. Per spec §5.4 JANITOR remains fire-and-forget — failure never blocks startup. New regression suite `PluginScopedStorageCoordinator.cacheBackendPreservation.test.ts` (3 tests). 99/99 cache-backend tests green.
- v5.8.12 - **Cloud-sync-aware cache.db backend** (PR #202): replaces file-based SQLite cache with IndexedDB on desktop (cloud-sync-immune by API surface), keeps `vault.adapter` file backend on mobile. New `CacheBlobStore` interface seam with `IndexedDBCacheBlobStore` (desktop) / `VaultAdapterCacheBlobStore` (mobile) implementations. `CacheBlobStoreFactory` uses simple `isDesktop()` switch — every existing desktop install with a `cache.db` file triggers a foreground-blocking migration FSM (DETECT→READ_LEGACY→WRITE_IDB→VERIFY→MARK_VERIFIED→JANITOR→DONE) on first launch with the new build. New `Nexus: Rebuild cache` command via re-entrancy-guarded `rebuildCache()`. Sticky restart Notice on first migration boot papers over a transient `waitForQueryReady` race during post-migration reconciliation (root-cause investigation deferred). Resolves the GDrive Shared Drive boot-hang incident: `[HybridStorageAdapter] waitForQueryReady timed out after 60000 ms` no longer fires under cloud-sync conflict-copy churn. Runtime-verified on Synaptic Labs vault. 99/99 cache-backend tests green. 0 Blocking findings; all 7 Minor remediated pre-merge. Known follow-up: `CONFLICT_COPY_PATTERNS` regex widening for Dropbox canonical `cache (User's conflicted copy YYYY-MM-DD).db` form.
- v5.8.11 - **CLI tool array-bracket fix** (PR #201, fixes #200): `ToolCliNormalizer` now strips an outer JSON-array-literal `[...]` pair on the CSV-fallback path of both `array<X>` and `oneOfArray` flag branches when the inner content fails `JSON.parse`. Previously, `useTools` calls like `content set-property --value "[[[A]],[[B]],[[C]]]"` corrupted wikilinks into `['[[A','[[B]]','C]]']` (observed on 9 production notes). New `stripOuterArrayBrackets` helper is depth-counting + quote-aware, so bare CSV like `[[A]],[[B]]` is left alone and the documented `["[[A]]","[[B]]"]` workaround continues to work. 170/170 ToolManagerCliSyntax tests pass with 3 new repro tests. Patch authored by @gcp007-ops.
- v5.8.10 - Sync-safe storage reconcile (Phase 1): fixes the GDrive Shared Drive task-revert incident. Three new pieces ship together: (1) conflict-copy regex relaxation in `ShardedJsonlStreamStore` (parser replaced with `parseShardFileNameWithConflict`) and `JsonlVaultWatcher` so `shard-NNNNNN (1).jsonl`, `[Conflict]`, `_conf(N)`, Dropbox-style, and iCloud `2` siblings are no longer dropped silently; (2) new `ReconcilePipeline` with three-layer idempotency (cursor fast-path on `lastEventId` tail-match + `applied_events` PK dedupe + INSERT OR REPLACE) — handles the silent-overwrite mode (full-file replacement, no conflict sibling) that was the actual incident pattern; (3) v11→v12 additive `shard_cursors` migration (per-file cursor keyed by full shardPath, never collapsed by baseIndex). `HybridStorageAdapter.handleExternalJsonlChange` now invokes `syncCoordinator.reconcileStream(category, streamId)` per-shard on external mtime change. Manual command Notice updated to `Reconciliation complete.`. 73/73 new Jest tests green including architect §6 silent-overwrite green-bar that reproduces the user's incident; perf gate 13ms warm @ 10K events. Phase 2 (cache.db relocation outside vault) deferred. `isDesktopOnly: false` preserved.

**Latest features** (Apr 2026):
- v5.8.8 - Workspace/memory/search batch + hydration race fix: PR #192 threads `workspaceId` through the session handle pipeline and partitions `sessionHandleMap` per workspace so sessions no longer leak across workspaces. PR #193 adds `WorkspaceFolderWatcher`, expands `WorkspaceContextBuilder`, and dedupes `recordActivityTrace` against the explicit-getSession path. PR #194 expands `MemorySearchProcessor` with CLI-trace pretty-printing and `useTools` result expansion (tracked as Phase 2 extraction candidate at 914 LoC). PR #195 plumbs `displaySessionId`/`sessionName` through the tool batch, request handlers, and connector while keeping `correctedId === originalSessionId` internal. PR #196 expands the eval harness with retry on transient errors, structured YAML config, broader scenario coverage, and a `/nexus-eval-harness` skill. PR #197 fixes issue #190: SQLite-hydration read race in `withReadableBackend` no longer falls through to legacy during the 1-3s warm hydration window (or 30-60s on cold boot) — `loadWorkspace` no longer returns "Workspace not found" and `listStates` no longer silently returns `[]` immediately after `Cmd+P → Reload`. `HybridStorageAdapter.waitForQueryReady` is now event-based (settled by phase transitions) with the 60s timeout demoted to a safety net.
- v5.8.7 - Workspace/state memory tool fixes: PR #191 makes workspace names first-class handles across create/load/update/list state flows, removes create response UUID requirements, routes saved states through the current runtime session ID instead of default session placeholders, removes public session CRUD exposure, improves workspace settings refresh/delete UX, and adds focused unit coverage for the end-to-end workspace/state paths.
- v5.8.6 - Content safety + model/provider fixes: PR #183 makes `content replace` tolerate Unicode normalization drift between file bytes and `oldContent`, while preserving untouched file bytes; PR #184 hardens those regression fixtures so future editor/tool normalization cannot turn them into tautologies. PR #187 validates leading Obsidian frontmatter before write/create/overwrite, rejects malformed or non-mapping YAML without rewriting valid bytes, and extends replace comparison to NFKC compatibility-normalized text such as ordinals, ellipses, and NBSPs. PR #188 adds GPT-5.5 / GPT-5.5 Pro across OpenAI and OpenRouter, adds GPT-5.5 to Codex defaults/fallbacks, and introduces a reusable live provider smoke test. PR #189 fixes Claude Code auth detection on Windows by preferring `.cmd`/`.bat` npm wrappers, adding `%APPDATA%\npm` discovery, and routing Claude headless spawning through the shared wrapper-aware process path.
- v5.8.5 — Tool Manager CLI parser hardening + Task Board liveness: PR #181 narrows `splitTopLevelSegments` so a comma is a structural command separator only when followed by whitespace/EOF (CSV array flag values like `--paths a,b,c` no longer explode into three pseudo-commands). PR #180 fixes `unescapeQuotedContent` default branch — `\X` outside the canonical set (`\n \r \t \" \' \\ \uXXXX`) now drops the phantom backslash (POSIX-shell semantics) instead of silently corrupting backticks/`$`/`#`/parens. PR #176 wires the Task Board view to storage external-sync events through the existing `TaskBoardSyncCoordinator` and emits update notifications on note-link mutations so card metadata stays live.
- v5.8.4 — Dynamic tool registry for app agents: `AppManager` register/unregister callbacks now sync with `ToolManagerAgent` so app agents (WebTools, Composer) installed at runtime appear in `getTools` discovery and execute via `useTools`. `GetToolsTool.refreshDescription()` rebuilds the description when the agent map mutates. Lint carry-over fix from #173: `isUnknownArray` predicate in `setProperty.ts` for typed `unknown[]` narrowing.
- v5.8.3 — setProperty CSV array parsing + scalar→array merge promotion (PR #173): `ToolCliNormalizer` handles `oneOf` array option (new `oneOfArray` marker) so `content set-property ... --value a,b,c` arrives as `["a","b","c"]` instead of the literal CSV string. `SetPropertyTool.execute` merge mode promotes scalar into existing array with union-dedup. Merge decision extracted as pure helper `computeMergeResult` (PR #172).
- v5.8.2 — ToolManager content alignment (PR #170): CLI-first contract finalized (nested `context`/`calls` rejected), CLI `\uXXXX` escape decoding, `executePrompts` action schema aligned with `insert`/`replace`/`write` (replace takes `oldContent`+`startLine`+`endLine`; `position` deprecated). Line-ending normalization (PR #169): `.gitattributes` establishes LF canonical.
- v5.8.0 — Glass-chrome chat UI redesign (ToolStatusBar, ContextBadge, ThinkingLoader, ToolInspectionModal), CLI-first MCP tool-calling contract (PR #157), Claude Opus 4.7 added, LLM pipeline fixes (Azure call_id + latent field preservation), new OpenRouter models (GPT 5.4/5.4-pro, Gemini 3 family, GLM 5.1, MiMo v2, Qwen 3.5, MiniMax M2.7), SQLite-from-JSONL sync trigger, branch management fixes, chat media model persistence
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

### Recently Merged (workspace/memory/search batch, 2026-04-29)
All 5 slices of `review/workspace-memory-batch` shipped to main:
- **#192** — B1 session-workspace-handle (thread workspaceId, workspace partitioning, sessionHandleMap eviction)
- **#193** — B2 workspace-folder-watcher (folder watcher + WorkspaceContextBuilder expansion + recordActivityTrace dedup)
- **#194** — B3 search-memory-processor-expansion (CLI-trace pretty-printing + useTools result expansion; MemorySearchProcessor.ts at 914 LoC, Phase 2 extraction tracked as `TraceMatchExpander`/`UseToolsResultFormatter` when next touched)
- **#195** — B4 tool-batch-display-session-id (displaySessionId/sessionName plumbing through tool batch + handlers + connector; correctedId=originalSessionId stays internal)
- **#196** — B5 eval-harness-expansion (retry, structured config, scenario coverage, `/nexus-eval-harness` skill)

Pre-existing `ModelAgentManager.test.ts` failure persists on main — out-of-scope, predates the batch.

### Recently Merged (cloud-sync-cache-backend + hotfix, 2026-05-07)

**PR #202** shipped as squash `cc6a8ebd` → released as **v5.8.12**. **PR #203** (hotfix) shipped as squash `4c7b76f7` → released as **v5.8.13**. Both branches and worktrees cleaned up. See "Latest features" entries above for full descriptions.

**Hotfix backstory** — Windows users reported the v5.8.12 cache migration re-running on every restart with `JANITOR done (removed=0, failed=1)`. Diagnosed two compounding bugs: (1) THE root cause — `PluginScopedStorageCoordinator.saveState` clobber wiping `cacheBackend` on every boot (cross-platform, Mac hidden because JANITOR succeeds → fresh-install fast-path); (2) Windows-specific JANITOR delete failure (Obsidian filesystem watcher holds transient handle). Both fixed in v5.8.13.

**Remaining follow-ups (deferred, not blocking):**
- **CONFLICT_COPY_PATTERNS regex widening** — current regex doesn't match Dropbox's canonical `cache (User's conflicted copy YYYY-MM-DD).db` form (closing paren before `.db` breaks anchor). Patch-class.
- **waitForQueryReady post-migration race** — first-boot transient timeout papered over with sticky restart Notice; root-cause investigation deferred. Repro: fresh migration boot, `TaskService.ensureQueryReady` hits 60s timeout while `PluginLifecycleManager.initializeEmbeddingsWhenReady` (also calling `waitForQueryReady`) succeeds. Suggests queryReady event surface doesn't fire for second-and-later callers in a specific window during post-migration reconciliation.

Substrate lesson pinned for retrospective: spawned PACT subagents had inconsistent MCP-tool access in this session; fallback pattern is **self-contained dispatch** (skip teachback ceremony, do work via Edit/Write/Bash, commit+push directly) — used successfully for backend-coder-3 (e65f3691) and test-engineer-5 (51d9dc25). 3 review docs were retracted mid-session (architect, backend, synthesis) when discovered to contain confabulated content from imagined SendMessage payloads after silent agent-spawn failures.

### Current Work

**Pattern-anchored `content replace` redesign (2026-05-11, MERGED → v5.9.0)** — PR #206 squash-merged to main as `bb00e524`. Branch + worktree deleted. Plan: `docs/plans/replace-tool-anchor-redesign-plan.md` (locked + IMPLEMENTED). Hard schema break landed: 4-field `{path, start, end, content}` replaces `{path, oldContent, newContent, startLine, endLine}` on both `ContentManager.replace` AND `executePrompts.replace` action in lockstep. No compat shim — old shape returns clean validation error. Findline-block helper subsumes `findContentInLines`; full-file `write` fallback in `executeReplaceAction` and `validate()` legacy branches deleted outright. PR #206 commits on the merge trace: `35864d6b` CODE, `6b5f5966` TEST, `0e29890a` JSDoc polish (A-F1+F2), `4f5a8784` test tightening (M1/M3/M4/T-F1). 46/46 jest green, `tsc --noEmit` clean. Reviewer verdicts: architect APPROVED 0/0/3 Future, test GREEN 0/4/3, backend GREEN 0/0/2. CLAUDE.md `## Pinned Context` updated in-place to reflect new shape (v5.9.0 marker on the CLI-first pin). **Session lesson worth pinning**: persist on-disk review artifacts BEFORE the wake-signal SendMessage — racing the wake with TaskGet/file-read produced a false-negative HANDOFF rejection cycle in this session. Pending: bump `package.json`/`manifest.json` to 5.9.0 and run `/nexus-release` skill when next at keyboard.

**ThinkingLoader continuity fix (2026-04-17)** — Branch `fix/thinking-loader-during-tools` (worktree `.worktrees/fix-thinking-loader-during-tools`), commit `4fc646f6`. Animated loader (noodling/forging) now stays mounted through tool execution instead of being wiped by `contentElement.empty()` on every tool-call update. Reconciled via new `MessageBubble.syncLoadingIndicator` — loader lives in `.ai-loading-header` sibling outside `.message-content` and is torn down only when (a) first text chunk arrives via new `MessageDisplay.notifyStreamingStarted` hook from `ChatView`, or (b) `isLoading=false`. 5 files +191/-21. Tests + build clean. Build artifacts copied to main plugin dir for manual smoke. One MEDIUM uncertainty: subagent streaming path not yet wired to `notifyStreamingStarted` (pre-existing edge case; net-positive regardless). Next: user testing → PR or coder fixes.

**Glass Chrome Audit + Remediation (2026-04-16)** — Post-merge audit of PR #131 + followups + 5 remediation bundles shipped in parallel waves. Reports: `docs/review/glass-chrome-{architect,frontend,qa,test}-review.md`. Triage walked 31 findings one-at-a-time; 23 queued, 3 skipped (QA M3/M4/M5), 1 Future overridden (Frontend F1), ~11 deferred as Future with qualifiers preserved.

**Remediation PRs shipped**:
- **PR #145** — Bundle A: strip dead `addEventListener` fallbacks in ToolInspectionModal + MessageBranchNavigator + BranchHeader (Architect M3 + Frontend M5/M6/D1).
- **PR #146** — Bundle G: test coverage for `ToolCallStateManager` + `MessageBubbleStateResolver` + `ToolEventCoordinator` (raised threshold 70/60 → 98/82) + tightened 2 integration-test fake-pass risks.
- **PR #147** — Wave 4: delete vestigial `getToolBubbleElement` + plug `ThinkingLoader` into Component tree via `addChild` + tie `ChatLayoutBuilder` MutationObserver cleanup to Component lifecycle (Architect M1 + Frontend M2/M9).
- **PR #148** — Wave 3: finish faux-glass pivot (strip 5 `backdrop-filter` sites, keep modal overlay as intentional carve-out, rewrite `styles.css:14-31`) + a11y sweep (`:focus-visible` on glass icon buttons, `aria-live` on `.tool-status-slot`, agent-slot overflow clip, opaque textarea, compacting-state pulse, WCAG comment fix, `ToolStatusEntry` dedup, `--chat-input-height` CSS var).
- **PR #149** — Bundle D: extract `ManagedTimeoutTracker` helper + migrate 5 fire-and-forget setTimeout sites + promote `AgentStatusMenu`/`UIStateController` `component` params to required (Frontend M1/M3/M4/M7 + original 8d881e6d pattern DRY'd).

**Pending**: Wave 5 (#17 extract `ChatKeyboardViewportController` from ChatInput + F2 cascade refactor + #23 rAF-throttle ToolInspectionModal scroll handler) — dispatching now.

**Session lessons pinned for future dispatches**:
- **CRLF/LF churn**: `ChatInput.ts`, `NexusLoadingController.ts` have mixed CRLF+LF line endings; Edit tool LF-normalization produces massive whitespace churn. Fix: byte-level Python patch preserving line endings. Coders must detect before editing and STOP on first bad diff rather than retry.
- **Reassign via fresh Agent spawn**: SendMessage reassignments across worktrees don't force `cd`, resulting in commits landing on wrong branch (hit on coder-invariant Wave 4 — recovered via cherry-pick + reset).
- **Shut down teammates at PR open**: idle hooks turn rest state into self-prodding work loops. Shut down as soon as their PR is live.

**Canonical Message Pipeline Refactor** — `docs/plans/canonical-message-pipeline-plan.md`. 4-phase plan to eliminate lossy `.map()` remap sites between storage and provider:
- **Phase 1+2 (DONE, PR #142 merged as `08b55cd9`)**: 11 commits. Phase 1 fixed Azure `Missing required parameter: 'input[N].call_id'` (root cause: `LLMService.generateResponseStream` remap stripped `tool_call_id`). Phase 2 preserved 3 latent fields (`reasoning_details`, `thought_signature`, `name`). Review remediation: 1 Blocking (removed leaky OpenRouter `console.log`), 8 Minor + 5 Future addressed across 4 parallel coders + 1 test-engineer. New helper `src/services/llm/utils/toolCallId.ts` (uses `crypto.randomUUID`). Foreign-id regex relaxed to `/^call_/`. Logger.logToConsole switch bug fixed (debug/info/warn now wired). Repro test moved to `tests/debug/` with env-gate.
- **Phase 3 (next, ~3-5h, medium risk)**: Drop the redundant `LLMService.generateResponseStream` remap entirely. Accept `ConversationMessage[]` directly. M7 widening already removed the parameter-type lie that made this look harder.
- **Phase 4 (later, 1-2 days)**: Single canonical message type. Worth doing when adding next provider (bedrock direct, vertex AI direct). F1 (storage vs wire `ConversationMessage` distinction) already documented at `ContextPreservationService.ts:16`.

**LLM Eval Harness** (`tests/eval/`, ~3500 lines, plan at `docs/plans/llm-eval-harness-plan.md`):
- 27/30 pass (90%) with multi-model coverage: Sonnet 4.6 (97%), GPT 5.4-mini (94%), GPT 5.4 (77%), Gemini 3 Flash (46%)
- **Next — Headless Agent Stack**: Replace fake tool schemas with real agents on TestVault. Plan in `docs/plans/`.

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
