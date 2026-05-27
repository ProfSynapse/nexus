<!-- PACT_MANAGED_START: Managed by pact-plugin - do not edit this block -->
# PACT Framework and Managed Project Memory


<!-- SESSION_START -->
## Current Session
<!-- Auto-managed by session_init hook. Overwritten each session. -->
- Resume: `claude --resume ba26186b-6640-4c2b-981b-dda63b752eb9`
- Team: `pact-ba26186b`
- Session dir: `/Users/jrosenbaum/.claude/pact-sessions/claudesidian-mcp/ba26186b-6640-4c2b-981b-dda63b752eb9`
- Plugin root: `/Users/jrosenbaum/.claude/plugins/cache/pact-marketplace/PACT/4.2.14`
- Started: 2026-05-27 02:11:12 UTC
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

### 2026-05-27 01:35
**Context**: Wave 3 PR1 TEST phase (claudesidian-mcp, branch feat/workspace-tab-pr1-foundation, session pact-ba26186b, 2026-05-27). PR1 TEST phase completed in ONE dispatch cycle: test-engineer TEACHBACK at Task #26, primary work HANDOFF at Task #27. ZERO test-side rejection cycles. 42 new tests added across 4 new test files (+1120 LoC). Full suite: 2863 passed / 17 skipped (baseline 2849 + 14 new from test-engineer; frontend-coder smoke had already added 28 in CODE). Build clean, lint clean. This memory captures the test-engineer institutional knowledge layer that complements memory 9af8282fa4826c8ec0f2cf23a944e221 (CODE-phase architectural patterns): jest.mock spy-class pattern for call-site integration tests, characterization tests for deliberately-deferred work, MockContainer pivot lesson, and the falsifiable-a11y-baseline pattern.
**Goal**: Capture the test-engineer institutional knowledge for PR1 TEST phase — testing patterns that are reusable for PR2/PR3/PR4 sweep waves and future settings-UI primitive testing — so the test approach doesn't have to be re-derived each wave. Companion to [[9af8282fa4826c8ec0f2cf23a944e221]] which captures the CODE-phase primitive contracts.
**Decisions**: jest.mock spy-class pattern (not full component-rendering) for ConfirmModal call sites at 3 sites, A11y gaps documented as characterization tests, NOT failures, StateDeleteConfirmModal characterization assertion (delete path does NOT use shared ConfirmModal) locks in the PR1 out-of-scope decision, MockContainer pattern from existing tests/unit/BoxedSection.test.ts reused for BoxedSectionStructure deepening (instead of querySelector), Dropped strict 'NOT addEventListener' negative assertion in registerDomEvent test — kept positive assertion only
**Lessons**: jest.mock spy-class pattern is the right shape for ConfirmModal call-site INTEGRATION tests in this codebase — mock the ConfirmModal module, capture constructor args + the onConfirm callback per call site, synthetically invoke captured callbacks to assert wiring. Avoids dragging in full renderer dependency graphs (TaskService, MemoryService, App mock, Plugin mock, etc.) while still asserting the integration contract (variant/title/body + onConfirm/onCancel resolution). Used at 3 call sites in tests/unit/ConfirmModalCallSites.integration.test.ts (12 tests). Reusable for PR2/PR3/PR4 ConfirmModal sweep coverage — the spy-class pattern scales to N call sites without renderer-setup cost growth., Characterization tests (assertions of CURRENT behavior that will fail loudly when a planned future change lands) are the right shape for deliberately-deferred sweep work. Example: StateDeleteConfirmModal characterization test asserts the delete path does NOT yet use the shared ConfirmModal — when PR2 sweeps the delete path to use shared ConfirmModal, that test will fail with a clear message naming the change. Similarly: ConfirmModalA11y.test.ts (6 tests) documents current a11y gaps as characterization assertions designed to FLIP to positive assertions when aria-labelledby/aria-describedby wiring lands. Lesson: deferred work should leave behind a falsifiable test baseline, not silent gaps — makes the deferred work self-announcing and impossible to forget., Cross-site invariant tests catch sweep-boundary regressions that per-site tests miss — example: ConfirmModalCallSites.integration.test.ts asserts PR1 wires NO variant=remove across all 3 call sites (deferred to PR2's set-membership removal flows). When PR2 adds variant=remove call sites, the invariant test will need to be relaxed at that boundary, surfacing the design intent at code-review time. Reusable for any wave-based PR series where one wave intentionally defers a variant/category and the next wave introduces it., MockContainer pattern + _children traversal + createEl/createDiv spy assertions is the canonical pattern for DOM-tree assertions in this codebase — the project does NOT use jsdom for DOM-tree tests; existing tests use _children-tracking mocks via the Obsidian-mocks layer. When tests need DOM-tree shape assertions (e.g., 'toolbar must be inside header, button must be inside toolbar'), use MockContainer pattern (frontend-coder established it at tests/unit/BoxedSection.test.ts:17-68). Initial querySelector approach failed because the Obsidian mock returns undefined — lesson: when in doubt, mirror the existing test-pattern in this codebase rather than reaching for jsdom-style querySelector idioms., Falsifiable-a11y-baseline pattern: when a11y verification can't be exhaustive in jsdom-less testEnvironment (can't assert role=dialog at runtime through Obsidian's Modal base), assert the structural primitives that ARE emittable (h2/p element presence via createElSpy, Cancel button presence) AND document the gaps as explicit characterization tests. The 2 GAP tests in ConfirmModalA11y.test.ts are designed to flip to positive assertions when aria-wiring lands — turning a coverage gap into a falsifiable invariant. Reusable for any UI primitive where full a11y assertion exceeds the test-environment capability., Dropped strict 'NOT addEventListener' negative assertion in registerDomEvent test lesson — the Obsidian Component mock internally calls el.addEventListener inside registerDomEvent for cleanup tracking, so the negative is unsatisfiable. Kept the positive 'registerDomEvent called with the action button + click' assertion instead. Lesson: when writing negative assertions about which API was called, verify the mock's internal call topology first — negative assertions on shared low-level APIs are usually false-flag-prone., Per-file coverage on the 4 touched production files (BoxedSection, ConfirmModal, StatesSectionRenderer, WorkspaceDetailRenderer) is meaningfully improved — call-site contract + structural invariants + service-delegation regression. The PR1 TEST phase shows the pattern for new-primitive introduction coverage: (a) primitive smoke (frontend-coder layer, structural assertions); (b) primitive structural deepening (test-engineer layer, nesting + identity + late-render invariants); (c) call-site integration via jest.mock spy-class pattern; (d) port regression (asserts byte-identical service-call shape for shell-only ports); (e) falsifiable-a11y-baseline. This 5-layer pattern is reusable for PR2/PR3/PR4 primitive introductions., Late-render re-use test pattern: use .empty() spy verification rather than asserting children-cleared because the mock's .empty() is jest.fn() not real DOM mutation. The contract being asserted is 'caller empties body, BoxedSection's body reference stays valid' — spy verification is sufficient. Lesson: when the mock surface and the production behavior diverge on side-effects, test the contract not the side-effect., Shell-only-port regression coverage pattern (for v5.9.7 archive-visibility preservation through StatesSectionRenderer port): the renderer is a thin delegation layer over StatesSectionService.listStates(workspaceId, includeArchived). Both branches of the Show archived toggle assert the correct includeArchived flag is passed through. v5.9.7 fix lives in MemoryService.getStates (covered by existing MemoryServiceGetStates.test.ts) — PR1 renderer test asserts the renderer correctly invokes the service interface that the fix protects. Reusable for any shell-only port whose underlying bug fix lives in a layer below: test the delegation surface, not the underlying fix (which has its own test).
**Reasoning chains**: Mission decomposition for PR1 TEST coverage: (a) Baseline regression check via full suite — green at 2849 confirmed pre-write; (b) ConfirmModal call sites: 3 — variant=delete (WorkspacesTab + WorkspaceDetailRenderer), variant=archive (StatesSectionRenderer), NO variant=remove (cross-site invariant). Spy-class pattern at module boundary best isolates contract; (c) StatesSectionRenderer port: v5.9.7 archive-visibility fix lives in MemoryService.getStates (covered by existing MemoryServiceGetStates.test.ts). Port concern is that the renderer continues to delegate verbatim to StatesSectionService — so both includeArchived branches + the archived-state surfacing must be asserted; (d) BoxedSection structural deepening: smoke (frontend-coder) covers headline assertions. Value-add is nesting invariants (toolbar must be inside header, button must be inside toolbar) + no inline style leakage (per CLAUDE.md non-negotiable) + identity stability for late-render pattern; (e) A11y on ConfirmModal: jsdom-less testEnvironment can't assert role=dialog at runtime — assert the structural primitives we DO emit + document the gaps for follow-up., Why TEST phase is captured as a SEPARATE memory from [[9af8282fa4826c8ec0f2cf23a944e221]] (CODE phase): the CODE memory captures primitive contracts + UX standards + scope-expansion process; the TEST memory captures testing patterns reusable for primitive coverage (jest.mock spy-class, characterization tests for deferred work, cross-site invariants, MockContainer reuse, falsifiable-a11y-baseline, shell-only-port regression coverage). The two memories serve different consumers — future implementers vs future test-engineers — and conflating them would dilute discoverability for both.
**Agreements**: Both open questions from test-engineer HANDOFF #27 flagged for team-lead routing: (1) aria-labelledby/aria-describedby wiring on ConfirmModal as follow-up issue (recommended YES — GAP tests give falsifiable baseline); (2) StateDeleteConfirmModal sweep tracking explicit (PR2 scope, currently implicit). These are post-harvest decisions for the lead, not blockers for memory close-out.
**Memory ID**: 40032dc0f23ad96177c804cbd87f5df0
<!-- PACT_MEMORY_END -->

<!-- PACT_MANAGED_END -->

# Claude Code Context Document
Last Updated: 2026-05-26

## Project Overview
- **Name**: Nexus (package: claudesidian-mcp)
- **Version**: 5.9.7
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

**Current Version**: 5.9.7
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

**Active branch**: `main`. **Open PRs**: none.

**In-flight (not yet PR'd):**
- **Settings UI redesign — Wave 3 (Workspaces tab)**: v3.1 mockup blessed 2026-05-26 (`docs/mockups/workspace-tab-redesign-v3-subpages.html`). 4-PR slice plan at `docs/plans/workspace-tab-redesign-plan.md`. **PR1 MERGED** (PR #220, squashed to main 2026-05-27): BoxedSection + ConfirmModal primitives, WorkspaceDetailRenderer/WorkspaceFormRenderer/StatesSectionRenderer shell ports preserving PR #216 v5.9.7 archive-visibility chain, ConfirmModal sweep across 3 call sites with `variant=delete` uniform on `confirmDangerousAction`, `styles.css` `.ws-section` family + breadcrumb fix at :5045. +2270/-246 across 13 files; full suite 2863 passed / 17 skipped; build+lint clean. Peer-reviewed by architect+frontend+test (0 Blocking, 8 Minor + 4 Future dispositioned). Review synthesis: `docs/review/pr220-wave3-pr1-2026-05-27.md`. **PR2 carry-forwards** (user-approved disposition, bundled into PR2 scope per plan §PR-Slicing): Group A — ConfirmModal hardening pre-task (~30 LoC: require `component`, add `onResolve`+`ConfirmModal.confirm()` helper, async error handling); Group B — `--space-*` token sweep on `.ws-section` family + wire `variant=remove` to workflow/keyfile × buttons; Group C — UX-outcome test layer (handler-wrapping integration tests + toggle-flip + re-instantiation coverage). **F-4 mobile-compat lint guard** tracked as #221. **Next**: PR2 (row primitives + checkbox sweep + Group A/B/C carry-forwards), PR3 (TaskDetail + Dependencies/Linked notes — production-ahead), PR4 (WorkflowEditor + FilePicker + mobile breakpoint).
- **Canonical Message Pipeline — Phase 3**: drop redundant `LLMService.generateResponseStream` remap; accept `ConversationMessage[]` directly. ~3-5h, medium risk. Plan: `docs/plans/canonical-message-pipeline-plan.md`. Phase 1+2 shipped in PR #142. Phase 4 (single canonical message type) deferred to next-provider-add.
- **Issue #88 — CustomPromptStorageService dual-write desync**: fix committed (3447d8c5) on `fix/issue-88-dual-write-desync` worktree, awaiting PR.
- **Context Budget Service**: `feat/context-budget-service` branch, work ongoing.
- **LLM Eval Harness** (`tests/eval/`, ~3500 lines, plan in `docs/plans/llm-eval-harness-plan.md`): 27/30 pass (90%) — Sonnet 4.6 (97%), GPT 5.4-mini (94%), GPT 5.4 (77%), Gemini 3 Flash (46%). Next: headless agent stack — replace fake tool schemas with real agents on TestVault.

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
