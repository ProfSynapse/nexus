# Large File Refactor Punchlist

Generated: 2026-04-07
Scope: Production TypeScript files over 800 lines, excluding `styles.css`, generated artifacts, tests, docs, and mockups.

---

## Progress Snapshot

- `ChatView` refactor is complete in this local checkout and is now `791` lines.
- `ModelAgentManager` refactor is complete on `origin/main` at `371a10c3` and reduced that file to `784` lines.
- This local checkout has not been reconciled with `origin/main`, so local file sizes may still show the pre-merge state for `ModelAgentManager`.
- Full test regression after the `ModelAgentManager` refactor passed: `106` suites, `1778` tests, `5` skipped.
- Full build validation surfaced existing repo-wide lint debt in `SQLiteCacheManager.ts` and one `no-console` warning in `PluginLifecycleManager.ts`.

## Next Recommended Target

Work next on `src/database/storage/SQLiteCacheManager.ts`.

Reason:

- it is still over threshold in this checkout at `935` lines
- it is the concrete blocker preventing `npm run build` from going green after the `ModelAgentManager` work
- it is already on the punchlist, so fixing it improves both architecture and build health

If the priority shifts back to chat-only cleanup instead of build health, the next UI target is `src/ui/chat/components/MessageBubble.ts`.

## Goals

- Reduce oversized files by extracting coherent responsibilities, not generic helpers.
- Improve SOLID boundaries so orchestration, persistence, rendering, and provider-specific behavior are easier to reason about.
- Remove obvious DRY duplication across LLM adapters and chat UI flows.
- Keep each change set PR-sized and behavior-preserving.

## Working Rules

- Prefer extraction by domain responsibility, not by arbitrary line-count slicing.
- Keep public interfaces stable unless there is a clear payoff.
- Preserve Obsidian plugin rules while refactoring: no dynamic `innerHTML`, use `registerDomEvent`, keep styles in `styles.css`.
- Land tests with each batch; do not postpone verification to the end.
- Avoid mixing architecture cleanup with unrelated bug fixes unless the refactor exposes one directly.

## In Scope

Line counts below are the baseline counts from the initial planning pass.

| File | Baseline lines | Primary concern | Status |
|------|---------------:|-----------------|--------|
| `src/ui/chat/ChatView.ts` | 1463 | Chat orchestration | Complete in local checkout (`791` lines) |
| `src/ui/chat/services/ModelAgentManager.ts` | 1101 | Chat selection/context state | Complete on `origin/main` (`784` lines) |
| `src/ui/tasks/TaskBoardView.ts` | 1008 | Task board rendering + interactions | Pending |
| `src/database/storage/SQLiteCacheManager.ts` | 923 | SQLite lifecycle + persistence | Next recommended target |
| `src/services/ConversationService.ts` | 919 | Conversation/message/branch service | Pending |
| `src/services/llm/adapters/openrouter/OpenRouterAdapter.ts` | 884 | Provider adapter | Pending |
| `src/services/llm/adapters/BaseAdapter.ts` | 884 | Shared adapter base | Pending |
| `src/database/adapters/HybridStorageAdapter.ts` | 852 | Storage orchestration | Pending |
| `src/ui/chat/components/MessageBubble.ts` | 841 | Message rendering + interaction | Pending |
| `src/services/llm/adapters/google/GoogleAdapter.ts` | 840 | Provider adapter | Pending |
| `src/services/llm/adapters/webllm/WebLLMEngine.ts` | 833 | Local model lifecycle | Pending |
| `src/services/llm/adapters/openai/OpenAIAdapter.ts` | 821 | Provider adapter | Pending |
| `src/database/interfaces/StorageEvents.ts` | 808 | Event type definitions | Pending |

## Out of Scope

- `styles.css`
- `package-lock.json`
- `tool-schemas.json`
- `src-compiled.md`
- tests, mockups, and research/docs-only files

---

## Batch 0: Baseline And Guardrails

- [x] Capture current line counts for the in-scope files.
- [x] Note current tests covering chat, task board, storage, and adapters.
- [x] Add or tighten characterization tests before moving logic that is weakly covered.
- [x] Decide an informal target ceiling for production files after refactor.
Recommended target: under 600 lines for concrete implementations, unless a type-only file is intentionally larger.

**Exit criteria**
- We know which tests must stay green for each batch.
- We are not starting structural changes blind.

---

## Batch 1: Chat Orchestration

### `src/ui/chat/ChatView.ts`

- [x] Extract startup and service-wait logic into a focused initializer/bootstrap collaborator.
- [x] Extract conversation loading/open/send/retry/edit flow into a dedicated workflow controller or service.
- [x] Extract branch navigation and parent/child view state handling into a branch navigation coordinator.
- [x] Extract pre-send compaction flow and transcript coverage building into a compaction coordinator.
- [x] Reduce `ChatView` to view lifecycle, dependency wiring, and top-level event delegation.

Completed via:

- `ChatSessionCoordinator`
- `ChatSendCoordinator`
- `ChatBranchViewCoordinator`
- `ChatSubagentIntegration`

### `src/ui/chat/services/ModelAgentManager.ts`

- [x] Extract conversation settings persistence and restore logic.
- [x] Extract workspace context loading/restoration and session resolution.
- [x] Extract compaction frontier and previous-context metadata handling.
- [x] Extract model/prompt/default selection resolution into a dedicated resolver.
- [x] Keep `ModelAgentManager` as a stateful facade rather than a grab bag of policies.

Completed on `origin/main` via PR `#112`.

### `src/ui/chat/components/MessageBubble.ts`

- [ ] Extract action button creation and branch navigator wiring.
- [ ] Extract image result detection/rendering.
- [ ] Extract render-mode switching between standard/group/tool states.
- [ ] Extract streaming update/tool event reconciliation if it still mixes state mutation with rendering.
- [ ] Leave `MessageBubble` responsible for composing specialized renderers only.

**Exit criteria**
- Chat view classes mostly coordinate collaborators rather than owning whole workflows.
- Compaction, branching, and rendering concerns are no longer intertwined in a single file.
- `MessageBubble` remains the last major chat-layer file in this batch.

---

## Batch 2: Task Board And Conversation Domain

### `src/ui/tasks/TaskBoardView.ts`

- [ ] Extract service initialization and refresh/sync behavior.
- [ ] Extract filter/sort/project-selection state helpers.
- [ ] Extract swimlane grouping and parent-progress calculation.
- [ ] Extract task card rendering and drag/drop behavior.
- [ ] Extract edit modal mapping and persistence flow.

### `src/services/ConversationService.ts`

- [ ] Split conversation CRUD from message CRUD.
- [ ] Split branch-specific operations into a branch-focused service/helper.
- [ ] Consolidate dual-backend conversion logic so it is not repeated inside large methods.
- [ ] Separate pagination/retrieval concerns from mutation concerns.
- [ ] Keep `ConversationService` as a facade over smaller conversation/message/branch services.

**Exit criteria**
- Task board rendering is broken into composable units.
- Conversation service methods stop mixing storage adaptation, conversion, branching, and business behavior in the same file.

---

## Batch 3: Storage Infrastructure

### `src/database/storage/SQLiteCacheManager.ts`

- [ ] Extract WASM/bootstrap/database-open flow.
- [ ] Extract file load/save/persistence responsibilities.
- [ ] Extract transaction management and locking.
- [ ] Extract admin/maintenance operations such as `vacuum`, stats, rebuild, and clear.
- [ ] Keep search delegation thin and avoid mixing search concerns with lifecycle code.

Build-health note:

- Repo-wide `npm run build` currently fails in `eslint .` primarily because of existing `@typescript-eslint/no-unsafe-*` violations in this file.

### `src/database/adapters/HybridStorageAdapter.ts`

- [ ] Move reconciliation logic for missing workspaces/conversations/tasks into focused migration or sync collaborators.
- [ ] Keep adapter initialization and readiness handling isolated from repository facade methods.
- [ ] Re-check that the adapter remains a true facade rather than a second business service layer.
- [ ] Trim any methods that only pass through to repositories and can live in narrower interfaces or generated sections.

### `src/database/interfaces/StorageEvents.ts`

- [ ] Split event definitions by domain: workspace/session/state, conversation/message/branch, project/task.
- [ ] Add a barrel file that preserves existing imports if needed.
- [ ] Keep shared base event types centralized.
- [ ] Avoid behavioral logic here; this should remain a types-only module set.

**Exit criteria**
- Storage boot, reconciliation, persistence, and event typing are separated by concern.
- Large infrastructure files are easier to scan and test in isolation.

---

## Batch 4: LLM Adapter DRY Pass

### Shared adapter layer

#### `src/services/llm/adapters/BaseAdapter.ts`

- [ ] Identify shared request-building, streaming, usage normalization, and error/logging patterns currently duplicated in providers.
- [ ] Extract shared provider helpers only when at least two adapters genuinely use them.
- [ ] Keep `BaseAdapter` from becoming a dumping ground for provider-specific branches.

### Provider adapters

#### `src/services/llm/adapters/openai/OpenAIAdapter.ts`
- [ ] Separate Responses API request construction from response parsing.
- [ ] Separate streaming diagnostics/logging from core generation logic.
- [ ] Isolate deep-research routing and tool-call handling boundaries.

#### `src/services/llm/adapters/google/GoogleAdapter.ts`
- [ ] Separate request body/header building from generation orchestration.
- [ ] Extract tool/schema conversion and source extraction utilities.
- [ ] Isolate streaming failure diagnostics from main generation flow.

#### `src/services/llm/adapters/openrouter/OpenRouterAdapter.ts`
- [ ] Separate request construction, generation stats retrieval, and tool execution continuation logic.
- [ ] Extract source/reasoning parsing helpers that are not unique to the main generation method.

#### Cross-adapter DRY checks
- [ ] Standardize request summary logging shape.
- [ ] Standardize source extraction result shape where possible.
- [ ] Standardize tool conversion conventions where provider APIs differ but the internal target is the same.
- [ ] Standardize finish-reason and usage mapping behavior where practical.

**Exit criteria**
- Provider adapters are still provider-specific, but the repeated plumbing has been pushed into small shared helpers.
- `BaseAdapter` gains clarity, not accidental complexity.

---

## Batch 5: WebLLM Lifecycle Cleanup

### `src/services/llm/adapters/webllm/WebLLMEngine.ts`

- [ ] Extract CDN/module loading and WebAssembly patching concerns.
- [ ] Extract model initialization/prefetch/readiness handling.
- [ ] Extract generation session and locking behavior.
- [ ] Extract unload/dispose/reset lifecycle management.
- [ ] Keep the main engine class focused on orchestrating the local model runtime.

**Exit criteria**
- WebLLM-specific crash workarounds and lifecycle logic are easier to reason about independently.

---

## Suggested Order

1. Batch 0
2. Batch 1
3. Batch 2
4. Batch 3
5. Batch 4
6. Batch 5

This order keeps the highest-churn UI orchestration work first, then storage, then cross-provider cleanup once the local boundaries are clearer.

---

## Definition Of Done Per File

- [ ] The file has one obvious primary responsibility.
- [ ] The largest methods have been split along meaningful domain boundaries.
- [ ] New collaborators have names that describe behavior, not implementation trivia.
- [ ] Tests cover the moved logic at the collaborator level where possible.
- [ ] Public behavior and persisted data formats remain unchanged unless explicitly intended.
- [ ] The resulting file is materially easier to scan than before, even if it is still above the aspirational line-count target.

---

## Notes

- `styles.css` is intentionally excluded from this punchlist.
- `StorageEvents.ts` is a valid split candidate even if it remains large, because it is type-only and naturally domain-partitioned.
- The adapter files should be treated as a coordinated cleanup pass rather than isolated one-off refactors; otherwise duplication will just move around.
