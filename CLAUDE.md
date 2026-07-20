<!-- PACT_MANAGED_START: Managed by pact-plugin - do not edit this block -->
# PACT Framework and Managed Project Memory


<!-- SESSION_START -->
## Current Session
<!-- Auto-managed by session_init hook. Overwritten each session. -->
- Resume: `claude --resume b3cecaa5-b21c-4ff1-8986-75b0d0d92091`
- Team: `session-b3cecaa5`
- Session dir: `/Users/jrosenbaum/.claude/pact-sessions/claudesidian-mcp/b3cecaa5-b21c-4ff1-8986-75b0d0d92091`
- Plugin root: `/Users/jrosenbaum/.claude/plugins/cache/pact-marketplace/PACT/4.4.49`
- Started: 2026-07-01 14:48:23 UTC
<!-- SESSION_END -->

<!-- PACT_MEMORY_START -->
## Retrieved Context

## Pinned Context

<!-- pinned: 2026-06-02 -->
### Tool-schema `required`/`oneOf`/`enum` is NOT runtime-validated (no ajv)
Agent tool param schemas (`getParameterSchema`) are DOCUMENTATION + CLI-normalizer hints only — there is NO ajv/JSON-schema validation behind `ToolBatchExecutionService.execute(params)`. A schema `required: [...]`, `oneOf`, or `enum` does NOT reject a malformed payload at runtime; bad input flows straight to the service. **Validation guards MUST live in the service/normalizer layer, not the schema.** Discovered v5.9.x (PR #236): a `createTask.linkedNotes` oneOf object missing `notePath` silently persisted `notePath:undefined` until an explicit guard was added in `normalizeLinkedNote` (TaskService). Rule: when a tool accepts structured input, add explicit field guards in the service/normalizer — never rely on the schema to enforce.

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

<!-- PACT_MEMORY_END -->

<!-- PACT_MANAGED_END -->

# Claude Code Context Document
Last Updated: 2026-05-26

## Project Overview
- **Name**: Nexus (package: claudesidian-mcp)
- **Version**: 5.15.3
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
- `vault.adapter` is acceptable for direct storage-path access when needed; normalize paths and resolve Nexus storage roots from settings instead of hardcoding `.nexus` or `Nexus`

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

**Current Version**: 5.12.2
Full changelog: `docs/changelog.md`

**Latest** (May 2026):
- **v5.9.7** — Archive visibility fix for tagged states (PR #218, commit `eae5f507` + version bump `05ce7199`): drops the `stateMeta.tags ? null :` shortcut at `MemoryService.getStates:555` so `adapter.getState` always runs. Pre-fix, the SQLite-metadata fast-path skipped JSONL content fetch for tagged states, and the skeleton return path never surfaced `state.metadata.isArchived` — UI list filter and AI-facing `listStates` filter both saw archived tagged states as active. Surgical 1 LoC + 3 regression tests (`MemoryServiceGetStates.test.ts`). Both UI and AI filters inherit the fix (read from same `getStates` output). Manually verified in Obsidian. Tech-debt follow-up tracked in **issue #219** (denormalize `is_archived` into SQLite metadata, ~80–120 LoC, v13 migration — restores the perf shortcut without correctness cost).
- **v5.9.6 + #215 / #216** (manually verified, **issue #215 closed**) — state CRUA tools (`updateState` + `archiveState`) added to MemoryManager + states management UI section under workspace settings. Contract: AI gets archive-only (soft, reversible); UI gets archive AND delete (humans can permanently destroy). No `deleteState` MCP tool exists. Storage extension: `state_updated` event mirroring `state_deleted` (~80 LoC across 9 files). 2 remediation cycles during review: Cycle 1 (B1 archiveState skeleton-corruption for tagged states, B2/B3 StateRepository event-fold + archive round-trip tests), Cycle 2 (M1 MemoryService.deleteState latent landmine — routed through `HybridStorageAdapter.deleteState` via `withDualBackend`). Post-merge manual-test surfaced the archive-visibility bug (fixed in v5.9.7 above). Frontend polish F1-F4 still open in **issue #217**.
- **v5.9.6** — Startup hydration recovery (PR #211, commit `3cf6d3f5` + version bump `f16356ac`): self-healing for stalled startup hydration in `StartupHydrationController`.
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

**Active branch**: `main` (feature work on `feat/agy-cli-reroute`, `fix/issue-272-taskboard-pagination`, `fix/issue-271-chat-loading-state`). **Open PRs**: #275 (#272 task-board undercount fix), #276 (#271a/b spinner + CLI process bound) — both await manual test + merge.

**v5.12.0 RELEASED 2026-06-13** (PRs #265–#267 + commits `abf26e03`/`780905f0`; workflow run 27475645444 success, 3 assets + attestations, no connector.js). Marquee: **Adaptive Search / self-improving local retrieval (#265)** — query-side low-rank adapter over the frozen MiniLM encoder, learned from implicit search→open feedback during idle 45-min "dream" cycles (`src/services/embeddings/adapter/`, ~3.1k LoC + 11 test files). On-by-default (opt-out `embeddings.retrievalLearning:false`), desktop-only, identity-safe (only promotes a tuning that beats a held-out test → "search can't get worse"), reversible (delete `<root>/data/embeddings/adapter.json`), fully local. Command: "Consolidate retrieval memory (dream now)". Default bake-off trains InfoNCE/BPR/KTO each round, best-on-held-out wins. User guide already shipped: `guide/adaptive-search.md` (README links it 3×). Also: **Task Board delete-task icon + cold-start empty-board fix (#267)** — board card now has a confirm-gated trash icon next to edit; `TaskBoardDataController.loadBoardData` now awaits `adapter.waitForQueryReady()` before reading (was rendering "No tasks" on cold cache because `workspaceService.getWorkspaces()` had no hydration gate, only TaskService did). **MCP read-batching nudge (#266)** — agent-facing prompt guidance only (batch known multi-file reads into one parallel `useTools` call); the learned next-tool predictor + eager prefetch were both measured against real vault traces and SHELVED. Framing decided with user: minor bump, headline-but-conservative on the learning feature, keep on-by-default. **Release-skill gap now CLOSED**: `versions.json` bump (5th file) is in the skill as of `abf26e03`; followed it correctly this release.

**v5.11.2 RELEASED 2026-06-12** (PRs #250–#264 + `c91631c0` + same-day fixes; workflow success, 3 assets + attestations). Same-day pre-release findings, all shipped in the release: Requesty live smoke found+fixed `google/gemini-3.5-flash` → `vertex/gemini-3.5-flash` (Requesty has no google/ alias for 3.5 Flash; other 12 slugs verified via live `/v1/models`); `tests/debug/provider-model-live-smoke.test.ts` extended with `requesty`+`anthropic` providers; eslint crash on `version-bump.mjs` fixed (`disableTypeChecked` doesn't cover third-party typed rules — explicit `obsidianmd/*: off` + `globals.node` in the JS/MJS block); changelog backfilled for 5.11.0/5.11.1. **Release-skill gap**: `versions.json` needs the new version entry (release.yml guard from #255) — skill's 3-file list is incomplete. **Remaining manual checks** (`docs/testing/manual-test-plan-post-5.11.1.md`, local-only): MCP socket connect on installed build, secure-key-storage round-trip. `action-gh-release` bumped v2→v3 for the June 16, 2026 Node 24 forced upgrade (next-release verify).

**In-flight (not yet PR'd):**
- **DEFERRED (won't-do, 2026-06-28): reasoning-LEVEL (low/medium/high) UI for local models.** Confirmed the gap is real & 3-part — (1) `ChatSettingsRenderer.renderReasoningControls` gates on `staticModelsService.findModel` which has NO `lmstudio`/`ollama` case (falls to `default: return []`), so the Reasoning toggle/effort-slider never renders for local providers; (2) adapters don't pass a level anyway — `OllamaAdapter` sends `think:<boolean>` (Ollama actually accepts `think:"low"|"medium"|"high"|"max"` for gpt-oss; verified via docs), `LMStudioAdapter` sends NO `reasoning_effort` (LM Studio defers to OpenAI param semantics, so gpt-oss WOULD honor `reasoning_effort`); (3) `ThinkingEffortMapper` has Anthropic/Google/Groq/DeepSeek/OpenAI entries but none for Ollama/LM Studio. Per-model nuance: levels apply only to gpt-oss-class; qwen3-thinking is always-on (`/api/v1/models` → `capabilities.reasoning.allowed_options:["on"]`). **User decision: leave it — users set reasoning effort in LM Studio's own UI where available.** Do NOT build A+B+C unless re-requested.
- **Local-model (LM Studio + Ollama) thinking / streaming / speculative-decoding fixes — UNCOMMITTED on `main`, awaiting user manual test (2026-06-26).** Build green (`main.js` rebuilt), lint+tsc clean, LMStudioAdapter tests 10/10, full sweep clean except the known pre-existing `TaskBoardEditCoordinator` jsdom-Modal failure. **DO NOT COMMIT until user tests** (standing constraint). Root cause found by live-curling the user's LM Studio: sending `draft_model` for speculative decoding against a **batched MLX** target returns `SpeculativeDecodingNotSupportedError` as an **in-stream `{"error":{...}}` frame over HTTP 200** (not an HTTP error) → `processNodeStream` silently swallowed it (no extractor matched) → empty stream → blank bubble / blank inspect / "stuck in reasoning". Fixes: (1) NEW `extractError` hook on `SSEStreamOptions` + `processNodeStream` (`BaseAdapter.ts`) — in-stream error frames now throw `LLMProviderError('…','PROVIDER_STREAM_ERROR')` instead of ending empty; (2) `LMStudioAdapter.generateStreamAsync` refactored to `streamChatOnce(requestBody)` private generator + try/catch that, on a draft error (HTTP **or** in-stream) before any real output, calls `markDraftIncompatible`, deletes `draft_model`, and `yield*`-retries without speculative → chat ALWAYS produces output (also covers tokenizer/vocab-mismatch drafts); (3) `ensureModelLoaded` — **restored `parallel:1`** in the load body (verified via `echo_load_config` that LM Studio DOES honor `parallel` despite it being absent from the public REST docs; MLX speculative needs a non-batched parallel:1 instance), now scans ALL `loaded_instances` and skips only when a suitable one exists (context match; parallel:1 required when a draft is configured) so it neither reloads every turn nor piles up duplicate instances; **flash_attention is passed through but NEVER compared** (llama.cpp-only; MLX no-op + unreported → comparing it caused infinite reloads — this was the "loads a NEW model every chat" bug). Endpoints confirmed correct/official: `/api/v1/models`, `/api/v1/models/load`. **MLX = the culprit**: batched-MLX bans speculative decoding and vision MLX never supports it; user is switching to **GGUF** (no batched restriction) — pair a GGUF target with a SAME-FAMILY GGUF draft for matching vocab. Also note `/api/v1/models` natively reports `capabilities.vision` + `capabilities.reasoning` (could later replace the name-regex thinking detection + vision gating). **Thinking rendering**: confirmed end-to-end WORKING — `reasoning_content`→`chunk.reasoning`→`MessageStreamHandler` synthetic `reasoning`-type tool call → `toolDisplayNormalizer.buildReasoningGroup` ("Reasoning" group, live) + persisted to `message.reasoning`. **REASONING-RENDER GAP — FIXED (2026-06-26, same uncommitted batch).** Root cause: reasoning flowed through every layer and was persisted to `message.reasoning`, but the FINAL render dropped it — `MessageBubble` computed `state.activeReasoning` and never used it, and the live path emitted a fragile synthetic `reasoning`-type tool call that the tool coordinator never rendered. Fix (7 files): NEW `onReasoningUpdate(messageId,text,isComplete)` event on `StreamHandlerEvents`/`MessageManagerEvents` replacing the synthetic tool call in `MessageStreamHandler` (deleted `createReasoningToolCall`); `ChatView.onReasoningUpdate` → `MessageDisplay.updateMessageReasoning` → `MessageBubble.updateReasoning` (live writer) + `MessageBubble.syncReasoningBlock` renders a collapsible `<details class="message-reasoning">` "Thinking" block from `getActiveReasoning` (auto-expands while streaming, collapses on complete) wired into both `createStandardMessageContainer` and `updateWithNewMessage`; `styles.css` `.message-reasoning*`; `ToolInspectionModal` now includes messages with reasoning (think-only responses appear) via `hasInspectableContent` + a default-open "Reasoning" data block. Build+lint+tsc clean; LMStudioAdapter 10/10, MessageStreamHandler+MessageManager tests pass. Touched files: `src/services/llm/streaming/SSEStreamProcessor.ts`, `src/services/llm/adapters/BaseAdapter.ts`, `src/services/llm/adapters/lmstudio/LMStudioAdapter.ts`, `src/services/llm/adapters/ollama/OllamaAdapter.ts`, `src/services/llm/adapters/shared/thinkingModels.ts` (NEW), `src/agents/toolManager/tools/getTools.ts` + `services/ToolCliNormalizer.ts` + `types.ts` (getTools compact-discovery bloat cap, ~25k→~3k), `src/components/llm-provider/providers/LMStudioProviderModal.ts` (speculative pair gating layers 1&2), + tests. Also uncommitted from earlier in same session: getTools compact-discovery cap, native thinking for LM Studio (`reasoning_content`) & Ollama (`think:true`/`message.thinking`), speculative-pair UI gating via `/api/v0/models` metadata.
- **AGY CLI re-route (issue #271c) — adapter swap in progress on `feat/agy-cli-reroute`** (`.worktrees/feat-agy-cli-reroute`, off current main). Plan: `docs/plans/agy-cli-reroute-plan.md` (APPROVED). Replaces deprecated `gemini` CLI runtime with Google Antigravity CLI (`agy` v1.0.10, `~/.local/bin/agy`) in the `google-gemini-cli` provider (provider id UNCHANGED for settings compat). **2 commits landed**: `518007fd` slice e (UI relabel → "Antigravity CLI"/"Google (Antigravity)", 3 files), `7d4b765c` slices a/b/c+R7 (binary swap geminiCli.ts:49; DELETE the gemini `--output-format json` JSON-parse pipeline → `parseAgyOutput`=stdout.trim seam, agy emits PLAIN TEXT + NO token usage; NEW `geminiCliModelNormalize.ts` FAIL-CLOSED allowlist — agy `--model` fails OPEN on bad slug so Nexus must reject; R7 `GeminiCliAuthService` strict→tolerant `access_token`-presence scan, boolean-only). Build green, adapter test rewritten to agy contract 6/6, suite 3601/0. **agy contract (verified v1.0.10)**: plain-text only (no `--output-format json`); `--model` takes human labels (`agy models`: "Gemini 3.5 Flash (Medium/High/Low)", "Gemini 3.1 Pro", "Claude Sonnet/Opus 4.6", "GPT-OSS 120B") and FAILS OPEN; no token usage; auth file-based `~/.gemini/oauth_creds.json` (may be multi-object → tolerant parse); **IGNORES `GEMINI_CLI_SYSTEM_SETTINGS_PATH`** (verified — so the old env-pointed temp-settings mechanism is dead for agy); native tool-restriction = `--sandbox` + permission-prompting (no `--dangerously-skip-permissions`). **Slice d PENDING** (invocation flags + tool-restriction posture + env-strip + deferred UI runtime strings): under focused agy-security re-review (Task #38) — leading design is `agy --print --model <label> --print-timeout <ms> --sandbox` with NO config write at all (eliminates the persistent-`~/.gemini`-write HIGH risk). Then TEST + peer-review. **Related**: PRs #275 (#272 task-board undercount) + #276 (#271a/b spinner+CLI-bound) OPEN, await manual test + merge; AGY branch rebases onto main after #276 to inherit the idle watchdog. SECURITY non-negotiables: auth probe boolean-only (never read/log/return token); no persistent ~/.gemini writes; no `--dangerously-skip-permissions`; allowlist-validate model labels.
- **Skills App (Skills Protocol integration) — FEATURE-COMPLETE on `feat/skills-app`, not yet PR'd** (`.worktrees/feat-skills-app`; 6 commits `07d50e3b`→`6302c460`). Full design: `docs/plans/skills-protocol-integration-plan.md`. Installable App (`src/agents/apps/skills/`, ComposerAgent-shaped, cross-platform, no creds), one-line registration in `AppManager.getBuiltInAppRegistry`. ALL phases shipped: discovery+index (v13 SQLite), loadSkill (loadWorkspace-shaped + usage history), CRUA (create/update/archive, archive-then-replace), import + sync-back (vault-root `.{provider}/skills/` ⇄ mirror, last-writer-wins), cross-context usage history (§9, trace `metadataJson.activeSkills` stamping, zero-migration), and the Settings → Apps → Skills management UI (via new `AppCustomSection` framework hook + `SkillsSectionRenderer`). Generic `AppRuntimeContext` (settings + storage-adapter + sessionContextManager getters) added to `BaseAppAgent` — opt-in, future apps reuse it. **Pre-PR adversarial audit (2026-05-31, 3 parallel auditors) → ALL findings fixed**: 5 BLOCKING (4 path-traversal/destructive-write — root cause: §7 "no traversal" never implemented + `normalizePath` doesn't strip `..`; + 1 scanner `(provider,name)` key-fork) + 5 MAJOR + 6 MINOR. Fix = new `skillPaths.ts` (`resolveVaultPath`/`assertInside`/`isSafePathSegment`) wired at every write/copy/remove boundary, provider validation, archived-exclusion on `findByName`, safe provider-scoped prune, `AppCustomSection` disposer hook (Component-leak fix), `hashSkillContent` (CRLF-normalized), LIKE-escape. Audit + resolution table: `docs/review/skills-app-prePR-audit-2026-05-31.md` (gitignored). **Full suite 3051 passed / 17 skipped / 0 failed; build+lint clean.** Net-new tests ~131 (incl. +41 audit-fix). ⚠️ Verified by unit tests + build only — NOT yet manually tested in Obsidian; mirror is empty until syncSkills import or createSkill runs. ⚠️ m5 (`adapter.list('')`→`'/'` vault-root discovery) still needs a manual MOBILE smoke check. **Next: PR + merge to main.** _(build history below.)_ **Phase 0 DONE (commit `07d50e3b`)**: app scaffold + 6 tool stubs, `types.ts`, `SkillValidator` (28 tests) + `SkillScanner` (7 tests — walks `<root>/skills/<provider>/<name>/SKILL.md` via `vault.adapter`, ignores `_`/`.`-prefixed, inline FNV-1a hash), **v13 SQLite migration** (`skills` table, UNIQUE(provider,name), CURRENT_SCHEMA_VERSION 12→13). **Phase 1 DONE (commit `e72e725b`)**: generic `AppRuntimeContext` injection (settings + storage-adapter getters → `BaseAppAgent.setRuntimeContext`, threaded via AppManager 5th ctor arg from AgentRegistrationService; `HybridStorageAdapter.getSqliteCache()` accessor) — opt-in, future apps reuse it. `SkillIndexService` (pure SQLite cache over `skills`; `syncFromScan` UPSERT preserves owned `is_archived`/`last_loaded_at`; recency-ordered `list`; `findByName`/`touchLoaded`; 12 tests). `SkillsContext.resolveSkillsRuntime` (settings→`<root>/skills` via resolveVaultRoot, vault.adapter, SQLite index+scanner; friendly errors). **listSkills + loadSkill now functional** (scan→sync→list/findByName; loadSkill §12-shaped: instructions+files+nudge+alternatives). Build+lint clean, 45 skills tests green. **Next**: CRUA (createSkill/updateSkill/archiveSkill via SkillValidator) + `SkillSyncService` (import from vault-root `.{provider}/skills/` + sync-back, archive-then-replace last-writer-wins, co-located `_archive/`) + usage-history attribution via `memory_traces.metadataJson.activeSkills` (§9) + settings UI for manual editing. ⚠️ mirror is empty until import/create lands, so listSkills returns [] today. ⚠️ sync-back WRITES to the user's real provider dotfolders — confirm scope before building.
- **Settings UI redesign — Wave 3 (Workspaces tab)**: v3.1 mockup blessed 2026-05-26 (`docs/mockups/workspace-tab-redesign-v3-subpages.html`). 4-PR slice plan at `docs/plans/workspace-tab-redesign-plan.md`. **PR1 MERGED** (PR #220, squashed to main 2026-05-27): BoxedSection + ConfirmModal primitives, WorkspaceDetailRenderer/WorkspaceFormRenderer/StatesSectionRenderer shell ports preserving PR #216 v5.9.7 archive-visibility chain, ConfirmModal sweep across 3 call sites with `variant=delete` uniform on `confirmDangerousAction`, `styles.css` `.ws-section` family + breadcrumb fix at :5045. +2270/-246 across 13 files; full suite 2863 passed / 17 skipped; build+lint clean. Peer-reviewed by architect+frontend+test (0 Blocking, 8 Minor + 4 Future dispositioned). Review synthesis: `docs/review/pr220-wave3-pr1-2026-05-27.md`. **PR2 carry-forwards** (user-approved disposition, bundled into PR2 scope per plan §PR-Slicing): Group A — ConfirmModal hardening pre-task (~30 LoC: require `component`, add `onResolve`+`ConfirmModal.confirm()` helper, async error handling); Group B — `--space-*` token sweep on `.ws-section` family + wire `variant=remove` to workflow/keyfile × buttons; Group C — UX-outcome test layer (handler-wrapping integration tests + toggle-flip + re-instantiation coverage). **F-4 mobile-compat lint guard** tracked as #221. **Next**: PR2 (row primitives + checkbox sweep + Group A/B/C carry-forwards), PR3 (TaskDetail + Dependencies/Linked notes — production-ahead), PR4 (WorkflowEditor + FilePicker + mobile breakpoint).
- **Canonical Message Pipeline — Phase 3**: drop redundant `LLMService.generateResponseStream` remap; accept `ConversationMessage[]` directly. ~3-5h, medium risk. Plan: `docs/plans/canonical-message-pipeline-plan.md`. Phase 1+2 shipped in PR #142. Phase 4 (single canonical message type) deferred to next-provider-add.
- **Issue #88 — CustomPromptStorageService dual-write desync**: fix committed (3447d8c5) on `fix/issue-88-dual-write-desync` worktree, awaiting PR.
- **Context Budget Service**: `feat/context-budget-service` branch, work ongoing.
- **LLM Eval Harness** (`tests/eval/`, ~3500 lines, plan in `docs/plans/llm-eval-harness-plan.md`): grades two-tool MCP usage via `RUN_EVAL=1`. Skill: `/nexus-model-eval`. Cloud leaderboard (mock mode, 35 scenarios): gemma-4-31b-it 91%, gemma-4-26b-a4b-it 89%, qwen3.6-27b 83%, qwen3.5-9b 80%, laguna-xs.2 80%. **PR #269 merged** the app-fidelity fixes (always-meta surface, CLI-arg parsing, search-slug corrections). **Local-model grading (uncommitted on main, 2026-06-19)**: `EvalRunner.ts`/`ConfigLoader.ts` add keyless `ollama`/`lmstudio` providers via `LMStudioAdapter`→`localhost/v1`; `eval.test.ts` now caps concurrency (`EVAL_CONCURRENCY`, defaults to **serial=1 for local single-slot servers** — concurrent fan-out at Ollama's one inference slot caused a 120s-timeout 500-storm that discarded the whole run), streams per-case progress to `test-artifacts/eval-progress-<ts>.log`, and treats per-job throws as non-fatal failed scenarios. gemma4:e4b on Mac ≈ 19 tok/s gen, ~30–56s/scenario, ~20–30 min full run. **Jest test-timeout now scales with serial lane count** (`eval.test.ts`; was a fixed ~8min that killed serial runs at 9/35; override `EVAL_TEST_TIMEOUT_MS`).

**Failure-pattern analysis + system-prompt iteration (uncommitted on main, 2026-06-19):** (1) **JSON report output** — `ReportGenerator.generateReportJson`/`saveReportJson` emit a `.json` sibling next to every `.md` (per-model + aggregate): untruncated tool-call args as objects, sorted `byModel` leaderboard, full turns/errors. Wired at both save sites in `eval.test.ts`. (2) **`excludeFromBoard` scenario flag** (`types.ts` → `ScenarioResult.excludedFromBoard`, stamped in the `finish()` choke point in `eval.test.ts`, honored in JSON `byModel`): run+reported but not scored, for known fixture bugs. (3) **Scenario filter already exists**: `EVAL_SCENARIO_NAMES=a,b,c` (comma-sep, via `config.scenarioNames`/`shouldRunScenario`) — use for targeted retests, no new code. (4) **System prompt reframed** (`SystemPromptBuilder.buildWorkingStrategySection`): two-phase EXPLORE/ACT → three buckets **exploration (search/list) → inspection (read) → exploitation (write/move/etc)** + soft one-line "after search you're encouraged to read the relevant file(s); search/list results are locations, not contents." Shared by prod+eval via `fixtures/system-prompt.ts`. (5) **multi-intent fixture bug fixed** (`vague-prompts.eval.yaml`): single `useTools` turn returned todo content for EVERY read, so following a search hit looped/bailed; rewrote as deterministic 3-round chain w/ `sequentialMockResponses` (api read returns real content), `excludeFromBoard:true` until re-verified. **Targeted cloud retest (n=1, mock):** 3-bucket prompt NET-POSITIVE on discovery/protocol — all-agents +3 fixed, get-tools/topic-switch qwen3.6 fixed, write-new-note laguna stopped hallucinating, vague-organize laguna+qwen3.6 fixed; BUT **search-then-read-chain unmoved (0/5)** — models search, get `{path,score}` (no content), fabricate the answer; soft prompt nudge does NOT overcome it. **Next lever (proposed): decorate the search/list tool RESULT** ("this is a location — call content read --path X"; result-side nudge the model can't ignore, doubles as recovery steer). **Op gotchas:** on test timeout the report-save block never runs (reports lost, only progress log survives) → recover from progress log, or make save timeout-resilient. **getTools-loop ROOT CAUSE found + `vague-organize` FIXED:** the scripted getTools mock is SELECTOR-INSENSITIVE (returns the same fixed blob for every call); `vague-organize` exposed only storage tools, so a model that planned to SEARCH for 2024 notes asked getTools for `search`, got storage back, read it as "discovery broken," and looped getTools forever at temp 0 (gemma-31b 24 calls/1307s). NOT an agent-name bug — both prod + eval `toKebabCase` strip `Manager` so `search`→`searchManager` resolves fine. Fix (`vague-prompts.eval.yaml`): getTools mock now exposes BOTH storage+search; result mocks switched to DOMAIN-tool keys (`storageManager_list`/`searchManager_content`/`storageManager_move`) so the executor's useTools fallback dispatches per inner command in ANY order/round; expectations relaxed to `getTools`(name-only, no params → selector check skipped) + the two `storage move`s, so list→move AND search→move both pass. VERIFIED: gemma-4-31b now PASS in 102s (was 1307s loop). **Production loop-breaker scoped (NOT built):** `docs/plans/gettools-loop-breaker-plan.md` — (A) `ToolContinuationService` per-exchange getTools tracker → steer on ≥3 consecutive or repeated-selector getTools ("you already discovered [...]; getTools returns schemas not data — call useTools"); (B) decorate getTools + search/list RESULTS with "these are schemas/locations — call useTools/content read next" (also fixes the search→read satisfice the system prompt couldn't). Steers never block; keep `TOOL_ITERATION_LIMIT=15` as final backstop. **`EVAL_TEMP` knob added** (`ConfigLoader.applyDefaultEnvOverrides`): overrides `defaults.temperature`; per-scenario `temperature:` still wins over it (precedence: scenario > EVAL_TEMP > config). All grading is temp 0 (deterministic) — which is also the WORST case for the getTools loop (greedy decoding can't jitter out of a stuck state). **Report-save now timeout-resilient** (`eval.test.ts`): `allResults` is populated incrementally in the per-scenario `finish()` (was pushed only after `mapWithConcurrency` resolved, so a mid-run test-timeout lost ALL reports — bit us twice: cloud targeted + qwen local); `afterAll` now saves partial JSON/MD on timeout. **qwen3.5:4b LOCAL graded (2026-06-19, new prompt, enforcement off, serial; full 38 across two runs after first timed out at 32):** BOARD 21 PASS / 16 FAIL of 37 (~57%, multi-intent excluded). Report-save-on-timeout fix + vague-organize de-loop both VERIFIED on the 6-scenario completion run (JSON+MD saved; vague-organize failed in 246s on a malformed getTools call, NOT the 1307s loop). Failures concentrate on PROTOCOL COMPREHENSION not chain-completion (the 4B wall): Pattern C skips getTools→calls useTools directly (~5: simple-read, create-new-note, expand-toolset, debug-two-exchange), Pattern B wrong agent/selector in getTools (~4: topic-switch asked for `prompt.*`, search-by-keyword `-help.search`, update-note dumped context-object into args.tool). Not bad for 4B; the loop-breaker + result-decoration (plan b) + 3-bucket prompt would help this size most. Next: headless agent stack — replace fake tool schemas with real agents on TestVault.

- **Context-contract enforcement + recovery testing (uncommitted on main, 2026-06-19):** PRODUCTION change — `useTools` now enforces the context contract that was previously declared-but-not-enforced (schema `required` is doc-only, no ajv). `ToolCliNormalizer` gained pure shared helpers `collectContextContractViolations()` / `formatContextContractError()` + method `validateExecutionContext()`; `UseToolTool.execute()` calls it first and throws a **recoverable steering error** when `memory`/`goal` are empty/placeholder (workspaceId/sessionId keep silent defaults, steer only on present-junk; constraints optional). getTools/discovery is exempt. 13 unit tests (`ToolManagerContextContract.test.ts`); full suite 3636 pass (only pre-existing `TaskBoardEditCoordinator` jsdom-Modal failure). The eval harness imports the SAME validator (single source) — `EvalToolExecutor` enforces it (`enforceContextContract` / `EVAL_ENFORCE_CONTEXT=1`) AND supports `forceContextSteering: N` (deterministically rejects the first N useTools calls with the real steering error to test recovery regardless of model behavior); `EvalRunner` grades recovery within `maxRecoveryRounds` (default 3); `tests/eval/scenarios/context-recovery.eval.yaml`. VERIFIED on gemma4:e4b: forced steering pushed it from `memory:'N/A'` to a real summary, then it re-issued and completed (steer=1, recovered=True, PASS). Insight: validation-driven recovery is non-deterministic (models send `''` vs `'N/A (First turn)'`), so `forceContextSteering` is the reliable test path. Follow-up: per-round mock response queue (current mock is name-keyed last-write-wins) for non-context recovery patterns (read→error→read→success); harness unit tests for the executor recovery logic.

**Open follow-ups (deferred, not blocking):**
- **Issue #217** — Frontend polish from PR #216 review: F1 (empty-name silent ignore in StateEditModal), F2 (no-op save fires noisy state_updated event), F3 (double-click race on Archive/Restore/Delete with no in-flight disable), F4 (stale-promise stomp on rapid workspace re-render). All Minor severity; not blocking.
- **Issue #219** — Denormalize `state.isArchived` into SQLite metadata (perf follow-up to v5.9.7 / #218). ~80–120 LoC + v12→v13 migration. Restores the fast-path read shortcut without sacrificing correctness. Not blocking until power-user workspaces hit 100–500+ states.
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

**Primary synced event store**: settings-derived vault root, `settings.storage.rootPath` (default `Nexus`) with managed data under `<rootPath>/data/`:
- `conversations/<conversationId>/shard-*.jsonl` - sharded append-only conversation events
- `workspaces/<workspaceId>/shard-*.jsonl` - sharded append-only workspace/session/state/trace events
- `tasks/<workspaceId>/shard-*.jsonl` - sharded append-only task/project events
- `_meta/` - storage and migration manifests

**Configured root rules**: resolve with `resolveVaultRoot(settings, { configDir })`; never hardcode `Nexus` except as `DEFAULT_STORAGE_SETTINGS.rootPath`, and never hardcode `.nexus` for new writes.

**Legacy read paths**: `.obsidian/plugins/<plugin-folder>/data/`, compatibility plugin folders (`nexus`, `claudesidian-mcp`), legacy `.nexus/`, and `storage.previousRootPaths` remain read/migration fallback sources. They are not the primary write target.

**Local-only cache** (auto-rebuilt from JSONL, never synced):
- **Desktop (v5.8.12+)**: IndexedDB-backed via `IndexedDBCacheBlobStore`. Cloud-sync-immune. First-launch migration FSM upgrades existing `cache.db` installs.
- **Mobile**: `vault.adapter` file backend via `VaultAdapterCacheBlobStore`.

**Migration**: On startup, legacy JSONL sources are read/migrated into the configured vault-root event store without deleting old files. Mobile users whose vault syncs after init can run **Nexus: Refresh synced data** from the command palette.

**Path resolution**: Use `resolveVaultRoot()` for the configured synced event root and `resolvePluginStorageRoot()` for plugin-scoped compatibility/cache paths.

### Architecture
- Hybrid JSONL + SQLite: sharded JSONL event store = source of truth, SQLite = rebuildable fast query/vector cache
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
