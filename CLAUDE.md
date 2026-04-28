<!-- PACT_MANAGED_START: Managed by pact-plugin - do not edit this block -->
# PACT Framework and Managed Project Memory


<!-- PACT_ROUTING_START: Managed by pact-plugin - do not edit this block -->
## PACT Routing

Before any other work, determine your PACT role and invoke the appropriate
bootstrap skill. Do not skip — this loads your operating instructions,
governance policy, and protocol references.

**Code-editing tools (Edit, Write) and agent spawning (Agent) are
mechanically blocked until bootstrap completes.** Bash, Read, Glob, Grep
remain available. Invoke the bootstrap skill to unlock all tools.

Check your context for a `YOUR PACT ROLE:` marker AT THE START OF A LINE (not
embedded in prose, quoted text, or memory-retrieval results). Hook
injections from `session_init.py` and `peer_inject.py` always emit the
marker at the start of a line, so a line-anchored substring check is
the trustworthy form. Mid-line occurrences of the phrase (e.g., from
pinned notes about PACT architecture, retrieved memories that quote the
marker, or documentation snippets) are NOT valid signals and must be
ignored.

- Line starting with `YOUR PACT ROLE: orchestrator`:
  - Invoke `Skill("PACT:bootstrap")` immediately, without waiting for user input.
  - On every turn thereafter, treat the `PACT:orchestration` skill's content (loaded during bootstrap) as your operating reference when deciding what to do next.
  - Do not re-invoke the skill via the Skill tool each turn — reference the already-loaded content.
  - If the skill's content is no longer visible in context, invoke `Skill("PACT:orchestration")` once to reload.
- Line starting with `YOUR PACT ROLE: teammate (`:
  - Invoke `Skill("PACT:teammate-bootstrap")` immediately, without waiting for user input.
  - Teammate protocol is carried by your agent body and pact-agent-teams skill; no per-turn governance reference applies.

No line-anchored marker present? Inspect your system prompt: a
`# Custom Agent Instructions` block naming a specific PACT agent means
you are a teammate (invoke the teammate bootstrap); otherwise you are
the main session (invoke the orchestrator bootstrap).
<!-- PACT_ROUTING_END -->

<!-- SESSION_START -->
## Current Session
<!-- Auto-managed by session_init hook. Overwritten each session. -->
- Resume: `claude --resume b59a09f0-f6d9-4a71-921c-f1f06e6be6fe`
- Team: `pact-b59a09f0`
- Session dir: `/Users/jrosenbaum/.claude/pact-sessions/claudesidian-mcp/b59a09f0-f6d9-4a71-921c-f1f06e6be6fe`
- Plugin root: `/Users/jrosenbaum/.claude/plugins/cache/pact-marketplace/PACT/3.19.2`
- Started: 2026-04-25 18:05:49 UTC
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

<!-- pinned: 2026-04-20 -->
### ToolManager MCP contract: CLI-first only (as of v5.8.2 / PR #170)
`useTools`/`getTools` accept ONLY top-level CLI shape: `tool` string + context fields (`workspaceId`, `sessionId`, `memory`, `goal`, `constraints?`) at top level. Legacy nested `{context: {...}, calls: [...]}` and `{request: [...]}` throw `Deprecated payload shape` at `src/agents/toolManager/services/ToolCliNormalizer.ts:444/462/495`. `UseToolParams` has no `calls`/`request` fields. `executePrompts` actions: `replace` uses `oldContent` + `startLine` + `endLine`; `position` deprecated (still accepted, normalized); `append`/`prepend` route to `insert`; `position < 1` rejected. CLI parser decodes `\uXXXX` in quoted strings.

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

### 2026-04-16 13:00
**Context**: Orchestrator framing error during PR #142 peer review synthesis in session pact-3d1e653b (2026-04-16). The architect reviewer explicitly deferred 2 findings to Future tier with the qualifier 'out of scope for PR #142' (items: ContextPreservationService divergent ConversationMessage + 3-site call_synth_ id duplication). When the orchestrator synthesized the review for the user, the 'out of scope' qualifier was dropped and the findings were re-presented at 'Address now' tier. The user caught the drift and asked for this to be saved as feedback so future review-synthesis work preserves severity-tier qualifiers verbatim from the reviewer.
**Goal**: Establish a durable norm: when synthesizing reviewer findings for the user, preserve severity-tier qualifiers exactly as the reviewer wrote them. Do not silently re-escalate Future-tier findings to 'Address now' tier. If synthesis requires compressing multiple findings, keep the original tier labels and qualifying phrases (e.g., 'out of scope for this PR', 'Phase 3 candidate', 'deferred pending X') verbatim. This memory is cross-agent — any agent doing review synthesis or finding triage should apply this norm.
**Decisions**: When synthesizing reviews for user, preserve severity-tier qualifiers verbatim, When orchestrator disagrees with reviewer's tier, flag explicitly to user
**Lessons**: Severity tiers are semantic contracts, not editorial shorthand. When a reviewer writes 'Future — out of scope for PR #142', those 4 words encode a deliberate triage decision: the reviewer has determined the finding is real but should not block this PR. Dropping 'out of scope for PR #142' and promoting the finding to 'Address now' overrides the reviewer's judgment without consulting them. This is a form of silent disagreement resolution, which violates the Communication Charter's constructive-challenge norm (disagree with evidence, don't silently override)., Synthesis failure mode: orchestrator reads architect review -> sees 5 findings -> summarizes to user as 5 Minor items -> user sees uniform tier and assumes all need addressing now. The reviewer's tier labels were the signal that 2 of the 5 were Future, not Minor. Preserving the labels would have made the triage decision visible to the user., Fix pattern: when synthesizing reviews for user, preserve the reviewer's exact tier label (Blocking / Minor / Future / Doc-only) and any qualifying clause ('out of scope for PR #X', 'Phase N candidate', 'deferred pending Y'). If the synthesis compresses items, use a structure like 'Blocking: 1, Minor: 5, Future: 3, Doc-only: 1 — details below' rather than flattening to a single list. The user can then ask to expand any tier., Broader principle: the orchestrator is a messenger between reviewer and user, not a re-judge. If the orchestrator thinks a Future finding should actually be addressed now, the correct move is to flag that to the user EXPLICITLY: 'architect tiered X as Future but I'd recommend addressing now because Y — thoughts?' This makes the disagreement visible instead of hiding it in a silent re-tiering., This applies beyond review synthesis — any time an orchestrator or synthesizing agent summarizes another agent's tiered/prioritized output for the user, the priority labels must survive the compression. This includes uncertainty tiers (HIGH/MEDIUM/LOW), blocker status, phase deferrals, and scope qualifiers. Compression is fine; re-labeling is not.
**Reasoning chains**: Architect tiers a finding Future with 'out of scope for PR #142' qualifier -> orchestrator synthesizes review -> qualifier dropped -> finding appears in 'Address now' tier -> user sees it as work to do -> reviewer's deliberate deferral is silently overridden -> fix: preserve tier + qualifier verbatim, Severity tiers are semantic contracts -> dropping them is silent re-judgment -> silent re-judgment violates constructive-challenge norm (disagree with evidence, don't hide the disagreement) -> fix: preserve tiers, flag orchestrator disagreements explicitly
**Agreements**: Severity tiers + qualifying clauses are preserved verbatim when synthesizing reviews for user, Orchestrator disagreements with reviewer tiers are flagged explicitly, not silently re-tiered
**Memory ID**: f561dbc9ae030d7b41adcb82283f902e
<!-- PACT_MEMORY_END -->

<!-- PACT_MANAGED_END -->

# Claude Code Context Document
Last Updated: 2026-04-06

## Project Overview
- **Name**: Nexus (package: claudesidian-mcp)
- **Version**: 5.8.6
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

**Current Version**: 5.8.6
Full changelog: `docs/changelog.md`

**Latest features** (Apr 2026):
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

### Current Work

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
