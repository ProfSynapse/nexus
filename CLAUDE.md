<!-- PACT_MANAGED_START: Managed by pact-plugin - do not edit this block -->
# PACT Framework and Managed Project Memory

<!-- SESSION_START -->
## Current Session
<!-- Auto-managed by session_init hook. Overwritten each session. -->
<!-- SESSION_END -->

<!-- PACT_MEMORY_START -->
## Retrieved Context

## Pinned Context

<!-- pinned: 2026-06-02 -->
### Tool-schema `required`/`oneOf`/`enum` is NOT runtime-validated (no ajv)
Agent tool param schemas (`getParameterSchema`) are DOCUMENTATION + CLI-normalizer hints only — there is NO ajv/JSON-schema validation behind `ToolBatchExecutionService.execute(params)`. A schema `required: [...]`, `oneOf`, or `enum` does NOT reject a malformed payload at runtime; bad input flows straight to the service. **Validation guards MUST live in the service/normalizer layer, not the schema.** Origin: a `createTask.linkedNotes` oneOf object missing `notePath` silently persisted `notePath:undefined` until an explicit guard was added in `normalizeLinkedNote` (`src/agents/taskManager/services/TaskService.ts:78`). Rule: when a tool accepts structured input, add explicit field guards in the service/normalizer — never rely on the schema to enforce.

<!-- pinned: 2026-04-20 -->
### Line endings: LF canonical via `.gitattributes`
`.gitattributes` declares LF canonical across `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs`/`.json`/`.md`/`.css`/`.html`/`.yml`/`.sh` + binary markers for images/audio/fonts/pdfs. If you see CRLF in the tree, it's a local-editor bug — fix the editor, don't chase it with tool normalization. If 500+ files show modified with a tiny `--ignore-cr-at-eol` delta, someone's editor wrote CRLF — re-run `git add --renormalize .` on that subset, don't let it land.

<!-- pinned: 2026-04-23 -->
### Dynamic ToolManager sync: deferred refactor (issue #174)
`AgentRegistrationService.syncToolManagerAgent` (`src/services/agent/AgentRegistrationService.ts:85`) + `ToolManagerAgent.registerDynamicAgent/unregisterDynamicAgent` (`src/agents/toolManager/toolManager.ts:117`) is a callback-wrap bridge that keeps `getTools` discovery in sync when `AppManager` installs/uninstalls app agents at runtime. Works today because `AppManager` is the only dynamic registrar. **Does not compose** for a second one. When a remote-MCP loader / plugin-extension agent / other dynamic registrar lands, refactor to event-based: add `onAgentRegistered`/`onAgentUnregistered` to `AgentManager`, have `ToolManagerAgent` subscribe in its constructor, delete the bridge + the `instanceof ToolManagerAgent` concrete import. Do NOT do this refactor speculatively — wait for the triggering consumer. Tracking: https://github.com/ProfSynapse/nexus/issues/174.

<!-- pinned: 2026-04-20, updated 2026-08-14 -->
### ToolManager MCP contract: CLI-first only
`useTools`/`getTools` accept ONLY the top-level CLI shape: a `tool` string plus context fields (`workspaceId`, `sessionId`, `memory`, `goal`, `constraints?`) at the top level. Optional top-level `strategy: 'serial' | 'parallel'` and `values: Record<string, string>` (see below). Legacy nested `{context: {...}, calls: [...]}` and `{request: [...]}` throw `Deprecated payload shape` at `src/agents/toolManager/services/ToolCliNormalizer.ts:757/775/808`. `UseToolParams` has no `calls`/`request` fields.

`content replace` and `executePrompts.replace` use the 4-field pattern-anchored shape `{path, start, end, content}` — `start`/`end` are TEXT anchors matched as whole lines (Unicode-normalized, so straight vs curly quotes compare equal), never line numbers. The pre-v5.9.0 `{oldContent, newContent, startLine, endLine}` shape gets a clean validation error, no compat shim. In `executePrompts`, `append`/`prepend` route to `insert`; `position < 1` is rejected. The CLI parser decodes `\uXXXX` in quoted strings.

**Context contract is now ENFORCED** (not just declared): `ToolCliNormalizer.collectContextContractViolations()` / `validateExecutionContext()` are called first in `useTools.ts:37` and throw a *recoverable steering error* when `memory`/`goal` are empty or placeholder. `workspaceId`/`sessionId` keep silent defaults and only steer on present-junk; `constraints` is optional. getTools/discovery is exempt. The eval harness imports the same validator (single source).

**Verbatim / multiline value transports** (do not flatten multiline content):
- MCP/chat: top-level `values` map, referenced from the tool string as `@key`. Substituted *after* tokenization with NO escape processing, so backslashes, quotes, and newlines survive exactly (`C:\temp`, LaTeX `\alpha`, regex `\d`). Quoting the token (`"@key"`) passes the literal text. A missing key, or a declared key the command never references, fails loud.
- Terminal CLI: `--<flag>-stdin` and `--<flag>-file <path>` hydrate *any* value-taking flag, not just `--content`. One `-stdin` per command (stdin reads once); several `-file` transports may coexist; a flag must not arrive both directly and via a transport.

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
Shared service at `src/services/llm/TranscriptionService.ts`; adapters at `src/services/llm/adapters/{provider}/`; types at `src/services/llm/types/VoiceTypes.ts`. Providers with word-level timestamps: **OpenAI** (`verbose_json`), **Groq**, **Mistral** (+diarization), **Deepgram** (+utterances, diarization, keyword biasing), **AssemblyAI** (+speaker labels).

⚠️ The ingest shim at `src/agents/ingestManager/tools/services/TranscriptionService.ts` strips word-level data — callers that need word timings must use the shared service directly.

**Drag-drop file path**: browser `File.name` is basename only — use `vault.getFiles().find(f => f.name === file.name)` to recover the vault-relative path in `handleIngestFiles`.

## Working Memory
<!-- Auto-managed by pact-memory skill. Last 3 memories shown. Full history searchable via pact-memory skill. -->

<!-- PACT_MEMORY_END -->
<!-- PACT_MANAGED_END -->

# Claude Code Context Document
Last Updated: 2026-08-14

## Project Overview
- **Name**: Nexus (package: `claudesidian-mcp`, manifest id `nexus`)
- **Version**: 5.16.4
- **Type**: Obsidian Community Plugin (`isDesktopOnly: false`, minAppVersion 1.8.7)
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
- `normalizePath()` does NOT strip `..` — path confinement needs an explicit `assertInside`-style guard at every write/copy/remove boundary

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
4. **Desktop-only features** (ingestion, composer, OAuth, CLI, MCP transports, data analysis): ensure all Node.js-dependent imports are lazy

**Known desktop-only npm packages**: mammoth, jszip, xlsx, yaml (all have Node.js transitive deps)

## Recent Changes

**Current version**: 5.16.4. Full changelog: `docs/changelog.md` — that file is the changelog; do not retell releases here. Only entries with a live, forward-looking consequence belong below.

- **v5.16.4** — multiline/verbatim value transports (`values` map, `--<flag>-stdin`/`--<flag>-file`) and honest CLI PATH reporting. The transport contract is pinned above; it is load-bearing for anything that passes content through a tool.
- **v5.16.2** — search ranking is a **single-scale tier ladder** in `src/agents/searchManager/tools/searchContent.ts`: `TITLE_EXACT_SCORE 0.95 > EXACT_PHRASE_SCORE 0.9 > ALL_WORDS_SCORE 0.8 > PARTIAL_MATCH_FLOOR 0.3 > FUZZY_ONLY_CEILING 0.25`. Never reintroduce a second scale (filename fuzzy used to be normalized to `1 + score/100`, which let a coincidental name beat a verbatim body match). `foldSeparators()` folds `-`/`_` to spaces on both sides. Results carry `matchType: 'content' | 'path' | 'semantic'`.
  **Test methodology rule that came out of it** — three defects shipped past a green suite. `tests/unit/SearchContentTool.test.ts` runs every ranking assertion twice with the vault enumerated in both orders and fails loudly if order decides it (a tie is not a ranking rule). `tests/debug/search-ranking-live-smoke.test.ts` (`RUN_SEARCH_SMOKE=1`) drives a live vault through the `nexus` CLI so the real `prepareFuzzySearch` runs. **The `prepareFuzzySearch` mock in `tests/mocks/obsidian/core.ts` charges a per-discontiguity penalty capped at 8 — do not make it proportional, or the tests go vacuous.**

## Quick Navigation

### Core Directories
- `/src/agents/` - Agent implementations (see Agent Architecture below)
- `/src/services/` - Shared services (LLM providers, memory, conversations, chat)
- `/src/components/`, `/src/ui/`, `/src/settings/` - UI components, chat view, settings tabs
- `/src/database/` - Storage adapters, SQLite cache, schema migrations
- `/src/types/`, `/src/utils/` - Type definitions and helpers

### Key Files
- `src/main.ts` - Plugin entry point and lifecycle management
- `src/connector.ts` - MCP server connector for Claude Desktop
- `src/agents/index.ts` - Agent registry
- `src/services/ConversationService.ts` - Chat conversation management
- `src/services/llm/core/LLMService.ts` - LLM provider abstraction layer
- `src/ui/chat/ChatView.ts` - Chat view
- `src/components/ConfigModal.ts` - Settings modal
- `src/utils/cliAssets.ts` - Shipped CLI guidance/help text (single-sourced to prod + docs)

## Agent Architecture

### Available Agents

**ToolManager** (`src/agents/toolManager/`) - **MCP Entry Point** (Two-Tool Architecture)
- `getTools`: Discovery — returns tool schemas for requested agents/tools
- `useTools`: Execution — unified context-first tool execution
- *Only these 2 tools are exposed to Claude Desktop. All other agents work internally.*

> Tool names below are the **CLI form** (`agent tool-name`, kebab-case) — what a
> caller types and what `getTools`/`useTools` resolve. Source of truth is the
> `slug:` field under `src/agents/**` (camelCase there, kebab-cased for CLI).
> Regenerate `cli-first-tool-schemas.json` with `npm run schemas:tools`.
> `tests/unit/shippedGuidanceCommands.test.ts` fails when shipped docs name a
> tool that does not exist.

**Always-on agents (8, 56 tools):**

1. **PromptManager** (`src/agents/promptManager/`) — custom prompts and LLM integration
   - `prompt`: execute, subagent, create, get, list, update, archive, list-models,
     generate-image, generate-audio, generate-video, check-generated-artifact
   - No delete — the AI gets `archive` (reversible). Media generation is async:
     `generate-*` returns a job, poll `check-generated-artifact <jobId>`.
2. **ContentManager** (`src/agents/contentManager/`) — note reading/editing
   - `content`: read, write, replace, insert, set-property
   - `read` requires `--start-line`. `replace` is pattern-anchored (see pinned contract).
3. **StorageManager** (`src/agents/storageManager/`) — file/folder management
   - `storage`: list, create-folder, move, copy, archive, open
4. **SearchManager** (`src/agents/searchManager/`) — search
   - `search`: content, directory, memory, query-notes
5. **MemoryManager** (`src/agents/memoryManager/`) — workspace/state/workflow management
   - `memory`: create-workspace, list-workspaces, search-workspaces, load-workspace,
     update-workspace, archive-workspace, create-state, list-states, load-state,
     update-state, archive-state, run
   - No session tools — sessions are context fields, not tools. `memory run`
     triggers a workflow (`--workflow-id`/`--workflow-name`). AI gets archive-only
     for states (soft, reversible); permanent delete is UI-only, there is no
     `deleteState` MCP tool.
6. **CanvasManager** (`src/agents/canvasManager/`) — Obsidian canvas
   - `canvas`: read, write, update, list
7. **TaskManager** (`src/agents/taskManager/`) — workspace-scoped projects/tasks with DAG dependencies
   - `task`: create-project, list-projects, update-project, archive-project,
     create, list, update, move, query, open, link-note
   - Note the asymmetry: project tools are suffixed (`create-project`), task tools
     are bare (`create`, `list`, `update`, `move`, `query`).
   - Services: TaskService (business facade), DAGService (pure computation).
     Auto-loads a task summary when a workspace loads.
8. **IngestManager** (`src/agents/ingestManager/`) — PDF/audio ingestion
   - `ingest`: run, capabilities

**Opt-in app agents (5, 18 tools)** — a vault only exposes the apps it enables:

9. **WebToolsAgent** (`src/agents/apps/webTools/`) — headless browser (desktop-only)
   - `web`: open, capture-markdown, capture-png, capture-pdf, links
10. **ComposerAgent** (`src/agents/apps/composer/`) — multimodal file composition
    - `composer`: compose, list-formats
11. **ElevenLabsAgent** (`src/agents/apps/elevenlabs/`) — AI audio
    - `elevenlabs`: list-voices, sound-effects, generate-music
    - No text-to-speech tool; TTS runs through `prompt generate-audio`.
12. **DataAnalysisAgent** (`src/agents/apps/dataAnalysis/`) — Pyodide pandas (desktop-only)
    - `data`: run-python, list-capabilities
13. **SkillsAgent** (`src/agents/apps/skills/`) — Skills Protocol
    - `skills`: list-skills, load-skill, create-skill, update-skill, archive-skill, sync-skills
    - Design: `docs/plans/skills-protocol-integration-plan.md`. Skills live under
      `<root>/skills/<provider>/<name>/SKILL.md`, indexed in the SQLite `skills`
      table; `sync-skills` mirrors to/from vault-root `.{provider}/skills/`
      (last-writer-wins) and **writes into the user's real provider dotfolders** —
      confirm scope before changing that behavior. Path confinement lives in
      `skillPaths.ts` (`resolveVaultPath`/`assertInside`/`isSafePathSegment`).

### Agent Structure Pattern
```
agents/
  [agentName]/
    [agentName].ts          # Main agent class extending BaseAgent
    tools/                  # Operation tools
      [toolName].ts
      services/             # Tool-specific services
    services/               # Agent-level shared services
    types.ts
    utils/
```

App agents additionally extend `BaseAppAgent` (`src/agents/apps/BaseAppAgent.ts`) and
may opt into `AppRuntimeContext` (`src/agents/apps/AppRuntimeContext.ts`) for settings,
storage-adapter, and session-context access.

### Base Classes
- **BaseAgent** (`src/agents/baseAgent.ts`)
- **BaseTool** (`src/agents/baseTool.ts`) — generic `BaseTool<Params, Result>`
- **IAgent** (`src/agents/interfaces/IAgent.ts`), **ITool** (`src/agents/interfaces/ITool.ts`)

## Current Work / Open Items

No in-flight uncommitted work is tracked here — the working tree is clean at 5.16.4.
Check `git log` and `docs/plans/` for what is actually in progress.

**Proposed, planned but not started** (each has a design plan and a tracking issue):
- **Web capture via Defuddle** — `docs/plans/web-capture-defuddle-plan.md`. Replace the
  Web Viewer `save-to-vault` dependency in `web capture-markdown` with Defuddle core
  plus Obsidian's `htmlToMarkdown()`; adds a mobile-capable fetch transport.
- **BasesManager agent** — `docs/plans/bases-manager-agent-plan.md`. `.base` file
  read/write/update/list plus `analyze`, which executes the query through Obsidian's
  own engine. The agent is not registered at all when Bases is disabled.
- **In-app verification via the Obsidian CLI** — `docs/plans/obsidian-cli-verification-plan.md`.
  build → `plugin:reload` → `dev:errors` → screenshot, so "works in Obsidian" stops
  being a human-only check.

**Deferred, with a live decision attached:**
- **Reasoning-LEVEL (low/medium/high) UI for local models — WON'T DO** unless
  re-requested. The gap is real and 3-part: (1) `ChatSettingsRenderer.renderReasoningControls`
  gates on `staticModelsService.findModel`, which has no `lmstudio`/`ollama` case;
  (2) `OllamaAdapter` sends `think:<boolean>` (Ollama accepts `"low"|"medium"|"high"|"max"`
  for gpt-oss) and `LMStudioAdapter` sends no `reasoning_effort`; (3) `ThinkingEffortMapper`
  has no Ollama/LM Studio entries. **User decision: users set reasoning effort in
  LM Studio's own UI where available.** Do not build this speculatively.
- **getTools loop-breaker — scoped, NOT built.** Plan: `docs/plans/gettools-loop-breaker-plan.md`.
  (A) a per-exchange getTools tracker in `ToolContinuationService` that steers on
  ≥3 consecutive or repeated-selector getTools calls; (B) decorate getTools and
  search/list *results* with "these are schemas/locations — call useTools / content
  read next". Partial (B) has landed in the system prompt (`SystemPromptBuilder`),
  `searchWorkspaces`, and shipped CLI guidance, but generic search/list result
  decoration and the tracker do not exist. Steers must never block; keep
  `TOOL_ITERATION_LIMIT=15` as the backstop.
- **Canonical Message Pipeline — Phase 3**: drop the redundant
  `LLMService.generateResponseStream` remap; accept `ConversationMessage[]` directly.
  ~3–5h, medium risk. Plan: `docs/plans/canonical-message-pipeline-plan.md`.
  Phases 1+2 shipped. Phase 4 (single canonical message type) deferred to the
  next provider add.

**Open bug follow-ups (deferred, not blocking):**
- `CONFLICT_COPY_PATTERNS` (`src/database/migration/CacheBackendMigration.ts:12`)
  does not match the Dropbox `cache (User's conflicted copy YYYY-MM-DD).db` form —
  the closing paren before `.db` breaks the anchor.
- `waitForQueryReady` post-migration race — first-boot transient timeout is papered
  over with a sticky restart Notice; root cause not investigated.
- `FilePickerRenderer.getRootFolder()` (`src/components/workspace/FilePickerRenderer.ts:191`)
  passes `/blog-test`-style paths to `getAbstractFileByPath()`, which expects no
  leading slash. Fix: `normalizePath()` or strip the leading slash.
- Claude Code `ENAMETOOLONG` (issue #64) — an earlier fix may not have fully
  resolved it. UNVERIFIED against current code; needs re-investigation.

**UNVERIFIED older items** (predate this clone's history; status unknown — confirm on GitHub before acting):
- Issue #217 — frontend polish from the states-management UI review: empty-name
  silent ignore in StateEditModal, no-op save firing a noisy `state_updated`,
  double-click race on Archive/Restore/Delete, stale-promise stomp on rapid
  workspace re-render. All Minor.
- Issue #219 — denormalize `state.isArchived` into SQLite metadata to restore the
  fast-path read shortcut lost in the archive-visibility fix. ~80–120 LoC + a
  migration. Not blocking until workspaces hit 100–500+ states.
- Issue #221 — mobile-compat lint guard.
- Issue #88 — `CustomPromptStorageService` dual-write desync.
- Settings UI redesign Waves/PRs 2–4 (row primitives, TaskDetail, WorkflowEditor +
  mobile breakpoint). Plan: `docs/plans/workspace-tab-redesign-plan.md`.

### Branch Architecture

A branch IS a conversation with parent metadata:
- `metadata.parentConversationId`: parent conversation
- `metadata.parentMessageId`: message the branch is attached to
- `metadata.branchType`: `'alternative' | 'subagent'`

**Key files**: `src/services/chat/BranchService.ts` (facade over ConversationService),
`src/ui/chat/controllers/SubagentController.ts`, `src/ui/chat/controllers/NexusLoadingController.ts`,
`src/ui/chat/services/ContextTracker.ts` (token/cost tracking).

### Known Issues

- **Workspace Delete Persistence**: deleted workspaces may reappear on reload.
  Backend delete logic looks correct; suspect UI cache. UNVERIFIED — long-standing,
  re-confirm it still reproduces before spending time on it.
- **WebLLM / Nexus Quark**: multi-turn tool continuations may crash on Apple Silicon
  (WebGPU). If startup hangs on "loading cache", clear site data.

## Development Notes

### Build Commands
- `npm run dev` — esbuild dev build
- `npm run build` — full production build (obsidian lint → CLI build → CLI content gen → `tsc --noEmit` → esbuild → connector tsc → connector content gen)
- `npm run build:cli` — CLI bundle + generated CLI content only
- `npm run test` — Jest
- `npm run lint` — ESLint (alias of `lint:obsidian`)
- `npm run schemas:tools` — regenerate `cli-first-tool-schemas.json`
- `npm run sync:agent-context` / `npm run sync:skills` — sync shipped agent context/skills
- `npm run deploy` — build + PowerShell deploy (Windows)
- **Release**: use the `/nexus-release` skill. It bumps `package.json`, `manifest.json`,
  `versions.json`, and the changelog — `versions.json` is guarded by the release
  workflow, so it is not optional.

### Testing Approach
- **Unit tests**: Jest, ~346 test files under `tests/`
- **Integration**: manual testing in Obsidian
- **MCP**: via Claude Desktop connection
- **LLM eval harness** (`tests/eval/`, `RUN_EVAL=1`, skill `/nexus-model-eval`):
  grades two-tool MCP usage. Plan: `docs/plans/llm-eval-harness-plan.md`.
  Useful knobs: `EVAL_SCENARIO_NAMES=a,b,c` (targeted retest), `EVAL_CONCURRENCY`
  (**defaults to serial=1** — local single-slot servers 500-storm under fan-out),
  `EVAL_TEMP`, `EVAL_TEST_TIMEOUT_MS`, `EVAL_ENFORCE_CONTEXT=1`. Per-case progress
  streams to `test-artifacts/eval-progress-<ts>.log`; reports save incrementally
  so a mid-run timeout still produces JSON + MD. Scenarios with known fixture bugs
  can set `excludeFromBoard: true` to run without scoring.
  **Harness gotcha**: the scripted getTools mock is selector-insensitive — it returns
  the same blob for every call. A scenario that exposes only some agents will make a
  model conclude "discovery is broken" and loop getTools forever at temp 0. Expose
  every agent the scenario could plausibly need.

### Code Patterns

- **Agents**: extend `BaseAgent`, register tools in the constructor
- **Tools**: extend `BaseTool<Params, Result>`, implement `execute()`, `getParameterSchema()`, `getResultSchema()`
- **Results**: return `{ success: boolean, ...data }` or `{ success: false, error: string }`
- **Services**: singletons with constructor dependency injection
- **Adding a new agent**: (1) add `initializeYourAgent()` to
  `src/services/agent/AgentInitializationService.ts`, (2) add
  `safeInitialize('yourAgent', ...)` to a phase in
  `AgentRegistrationService.doInitializeAllAgents()`. No factory classes, no
  ServiceDefinitions entry.

### Dependencies
See `package.json`. Key: MCP SDK, express, winston, uuid. LLM provider SDKs were
removed — providers talk direct HTTP via `ProviderHttpClient`.

## Code Quality

Large-file punchlist: `docs/plans/large-file-refactor-punchlist.md`.

**600+ line files to watch** (re-measured 2026-08-14 with `wc -l`):

| Lines | File |
|------:|------|
| 1426 | `src/utils/cliAssets.ts` |
| 1247 | `src/components/shared/ChatSettingsRenderer.ts` |
| 1214 | `src/settings/tabs/GetStartedTab.ts` |
| 1182 | `src/ui/chat/ChatView.ts` |
| 1167 | `src/agents/toolManager/services/ToolCliNormalizer.ts` |
| 1150 | `src/settings/tabs/DefaultsTab.ts` |
| 1052 | `src/services/ConversationService.ts` |
| 1019 | `src/database/adapters/HybridStorageAdapter.ts` |
|  999 | `src/ui/chat/services/ModelAgentManager.ts` |
|  941 | `src/agents/taskManager/services/TaskService.ts` |
|  916 | `src/agents/searchManager/services/MemorySearchProcessor.ts` |
|  901 | `src/services/cli/LocalCliInstaller.ts` |
|  890 | `src/settings/tabs/WorkspacesTab.ts` |
|  880 | `src/services/llm/adapters/openrouter/OpenRouterAdapter.ts` |
|  871 | `src/services/llm/adapters/BaseAdapter.ts` |
|  854 | `src/database/interfaces/StorageEvents.ts` |
|  846 | `src/services/llm/adapters/google/GoogleAdapter.ts` |
|  839 | `src/services/llm/adapters/lmstudio/LMStudioAdapter.ts` |
|  829 | `src/services/llm/adapters/webllm/WebLLMEngine.ts` |
|  784 | `src/services/llm/adapters/openai/OpenAIAdapter.ts` |
|  774 | `src/services/WorkspaceService.ts` |
|  770 | `src/connector.ts` |
|  710 | `src/database/storage/SQLiteCacheManager.ts`, `src/settings/tabs/ProvidersTab.ts` |
|  673 | `src/services/llm/providers/ProviderManager.ts` |

**Plugin store compliance**: `isDesktopOnly: false` is correct. VaultOperations uses
`app.fileManager.trashFile()` (constructor takes `App` as its first arg).

## MCP Integration

### Server Configuration
- Server runs locally via `connector.js`
- Configured in Claude Desktop's `claude_desktop_config.json`
- Server identifier: `claudesidian-mcp-[vault-name]`
- Supports multiple vault instances simultaneously

### Two-Tool Architecture

Instead of 70+ tools, MCP exposes just 2: `getTools` (discovery) and `useTools` (execution).

**Context schema**: `{ workspaceId, sessionId, memory, goal, constraints? }` —
all required except `constraints`, and **enforced at runtime** (see the pinned
ToolManager contract for exactly what steers vs. silently defaults).

**Flow**: `getTools` → get schemas → `useTools` with the context fields at the top
level plus a single `tool` string. Batch by separating commands with a top-level
comma outside quotes:
`"storage list --path Notes, content read --path a.md --start-line 1"`.

⚠️ The `calls: [{agent, tool, params}]` array and the nested `context: {...}` object
were removed in v5.9.0 and are rejected outright (`Deprecated payload shape`).
Context fields must NOT appear as CLI flags inside the `tool` string either.

**Benefits**: large token reduction vs. exposing every tool schema; works with
small-context models.

**Key files**: `src/agents/toolManager/` (agent + tools),
`src/services/trace/ToolCallTraceService.ts`, `src/utils/cliAssets.ts` (shipped guidance).

**Tool count**: 74 tools across 13 agents (excluding the 2 ToolManager meta-tools) —
56 across the 8 always-on agents, plus 18 across the 5 opt-in apps. The checked-in
`cli-first-tool-schemas.json` shows 66 tools / 11 agents because it was generated
from a vault with `skills` and `data` disabled; regenerate with `npm run schemas:tools`.

## Memory & Workspace System

### Storage Location

**Primary synced event store**: settings-derived vault root,
`settings.storage.rootPath` (default `Nexus`), with managed data under `<rootPath>/data/`:
- `conversations/<conversationId>/shard-*.jsonl` — sharded append-only conversation events
- `workspaces/<workspaceId>/shard-*.jsonl` — workspace/session/state/trace events
- `tasks/<workspaceId>/shard-*.jsonl` — task/project events
- `_meta/` — storage and migration manifests

**Configured root rules**: resolve with `resolveVaultRoot(settings, { configDir })`
(`src/database/storage/VaultRootResolver.ts:133`). Never hardcode `Nexus` except as
`DEFAULT_STORAGE_SETTINGS.rootPath`, and never hardcode `.nexus` for new writes.

**Legacy read paths** (read/migration fallback only, never the write target):
`.obsidian/plugins/<plugin-folder>/data/`, compatibility plugin folders (`nexus`,
`claudesidian-mcp`), legacy `.nexus/`, and `storage.previousRootPaths`.

**Local-only cache** (auto-rebuilt from JSONL, never synced):
- **Desktop**: IndexedDB via `IndexedDBCacheBlobStore` — cloud-sync-immune. A
  first-launch migration FSM upgrades existing `cache.db` installs.
- **Mobile**: `vault.adapter` file backend via `VaultAdapterCacheBlobStore`.
- Chosen by `src/database/storage/CacheBlobStoreFactory.ts`.

**Migration**: on startup, legacy JSONL sources are read/migrated into the configured
vault-root event store without deleting old files. Mobile users whose vault syncs
after init can run **Nexus: Refresh synced data**. **Nexus: Rebuild cache** recovers
from a corrupted cache.

**Path resolution**: `resolveVaultRoot()` for the configured synced event root;
`resolvePluginStorageRoot()` (`src/database/storage/PluginStoragePathResolver.ts:26`)
for plugin-scoped compatibility/cache paths.

### Architecture
- Hybrid JSONL + SQLite: the sharded JSONL event store is the source of truth;
  SQLite is a rebuildable fast query/vector cache
- **SQLite schema version 13** (`CURRENT_SCHEMA_VERSION` in
  `src/database/schema/SchemaMigrator.ts:76`) — v9 added the 4 task tables, v10
  workflow columns, v11 the archive flag, v12 `shard_cursors`, v13 the `skills` table
- True database pagination with OFFSET/LIMIT
- Workspace-scoped sessions and traces
- Searchable via MemoryManager and SearchManager agents

## UI Components

- **Chat view**: `src/ui/chat/ChatView.ts` — conversations, branching, streaming, tool accordion
- **Settings**: `src/components/ConfigModal.ts` + `src/settings/tabs/` — tabbed LLM/agent configuration

### Chat Suggesters
| Trigger | Purpose |
|---------|---------|
| `/` | Tool hints |
| `@` | Custom agents / prompts |
| `[[` | Note links |
| `#` | Workspace data |

Key files: `src/ui/chat/components/suggesters/` (`ToolSuggester`, `PromptSuggester`,
`NoteSuggester`, `WorkspaceSuggester` + TextArea/ContentEditable variants,
`initializeSuggesters.ts`), `src/ui/chat/services/MessageEnhancer.ts`,
`src/ui/chat/services/SystemPromptBuilder.ts`.

## Architectural Notes

- **Subagents**: branch → stream via LLMService → save result. `chunk.toolCalls` are display-only.
- **Reasoning / thinking rendering**: reasoning streams as `chunk.reasoning`, is
  emitted via `onReasoningUpdate(messageId, text, isComplete)` on
  `StreamHandlerEvents`/`MessageManagerEvents`, and renders as a collapsible
  `<details class="message-reasoning">` block. Do NOT reintroduce a synthetic
  `reasoning`-type tool call — the tool coordinator never rendered it.
- **In-stream error frames**: some providers (notably LM Studio) return
  `{"error":{...}}` frames over HTTP 200. `SSEStreamOptions.extractError` +
  `processNodeStream` in `BaseAdapter.ts` turn those into
  `LLMProviderError(..., 'PROVIDER_STREAM_ERROR')` instead of an empty stream.
  Any new streaming adapter should wire `extractError`.
- **LM Studio speculative decoding**: a `draft_model` against a batched-MLX target
  fails; `LMStudioAdapter` marks the draft incompatible and retries without it, so
  chat always produces output. `ensureModelLoaded` passes `flash_attention` through
  but **never compares it** (llama.cpp-only; MLX no-ops and does not report it —
  comparing caused infinite model reloads).
- **Antigravity CLI (`agy`)**: the `google-gemini-cli` provider id is unchanged for
  settings compat, but the runtime is `agy`, not the deprecated `gemini` CLI. `agy`
  emits **plain text** (no JSON output mode) and reports **no token usage**;
  `--model` takes human labels and **fails open** on an unknown slug, so
  `geminiCliModelNormalize.ts` is a **fail-closed allowlist** — keep it that way.
  Auth is a boolean-only presence probe over `~/.gemini/oauth_creds.json`; never
  read, log, or return the token. No `--dangerously-skip-permissions`.
- **WebLLM / Nexus Quark**: 4B, 4K context, `<tool_call>` format. May crash on Apple Silicon.
- **Storage**: branches are JSONL events; tool names use the `agent_tool` format.
- **Apps & vault access**: app agents that produce files must have vault access
  wired through `BaseAppAgent`. Use `vault.createBinary()` for binary outputs
  (audio, images) and `vault.create()` for text. Always ensure parent directories
  exist before writing.
