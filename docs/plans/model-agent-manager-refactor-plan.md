# ModelAgentManager Refactor Plan

Generated: 2026-04-07
Target file: `src/ui/chat/services/ModelAgentManager.ts`
Local checkout size at plan time: 1107 lines
Worktree: `.worktrees/model-agent-manager-refactor`
Branch: `codex/model-agent-manager-refactor`
Status: Completed and merged to `origin/main` in PR `#112`
Merged commit on `origin/main`: `371a10c3`
Refactor result on `origin/main`: 784 lines

## Goal

Reduce `ModelAgentManager` to a stateful facade that owns current chat-selection state and delegates:

- conversation settings hydrate/persist behavior
- workspace/session restore and binding
- default model/prompt/settings resolution
- compaction frontier and context-budget policy
- system-prompt input assembly

The end state should keep the current public API stable for `ChatView`, `ChatSettingsModal`, `ChatSessionCoordinator`, and `ChatSendCoordinator`.

## Outcome

This refactor is complete on `origin/main`.

Extracted collaborators:

- `src/ui/chat/services/ModelAgentConversationSettingsStore.ts`
- `src/ui/chat/services/ModelAgentWorkspaceContextService.ts`
- `src/ui/chat/services/ModelAgentDefaultsResolver.ts`
- `src/ui/chat/services/ModelAgentPromptContextAssembler.ts`
- `src/ui/chat/services/ModelAgentCompactionState.ts`

Result:

- `ModelAgentManager` was reduced from `1107` lines to `784` lines in the merged branch
- the manager now reads as a stateful facade over extracted collaborators instead of a mixed policy/persistence/state class
- the public API used by chat UI/services was preserved

Verification completed during the refactor:

- targeted Jest suites passed:
  - `tests/unit/ModelAgentManager.test.ts`
  - `tests/unit/ModelAgentManagerContextGating.test.ts`
  - `tests/unit/ModelAgentManagerCompactionPersistence.test.ts`
- focused `eslint` on changed files passed
- full regression `npm test` passed:
  - `106` suites passed
  - `1778` tests passed
  - `5` skipped
- `npm run build` was still blocked, but only by unrelated existing lint issues in:
  - `src/database/storage/SQLiteCacheManager.ts`
  - `src/core/PluginLifecycleManager.ts`

Notes:

- This local checkout may still show the pre-refactor `ModelAgentManager` until it is reconciled with `origin/main`.
- Keep this file as the historical implementation plan and completion record for PR `#112`.

## Current Responsibility Clusters

### 1. Conversation settings restore/persist

Methods:

- `initializeFromConversation()`
- `restoreFromConversationMetadata()`
- `saveToConversation()`
- `getCurrentSessionId()`

Problems:

- mixes metadata reads, model/prompt restoration, workspace binding, and fallback/default initialization
- save/restore rules for `chatSettings` are buried inside a broad state manager
- session lookup is coupled to the whole manager

### 2. Workspace/session binding and loaded workspace data

Methods:

- `restoreWorkspace()`
- `setWorkspaceContext()`
- `clearWorkspaceContext()`
- `getWorkspaceContext()`
- `getLoadedWorkspaceData()`

Problems:

- workspace loading, session binding, and state assignment are mixed with prompt/model selection logic
- the workspace restore path exists in both default initialization and conversation restore flows

### 3. Default selection and restore resolution

Methods:

- `initializeDefaults()`
- `initializeDefaultModel()`
- `getSelectedModelOrDefault()`
- `resolveModelOption()`
- `setSelectedModelById()`
- `getAvailableModels()`
- `getAvailablePrompts()`

Problems:

- default resolution also clears unrelated state and loads plugin settings
- model/prompt discovery and fallback placeholder behavior are coupled to global state mutation

### 4. Prompt assembly and message options

Methods:

- `handlePromptChange()`
- `getCurrentSystemPrompt()`
- `getMessageOptions()`
- `buildSystemPromptWithWorkspace()`
- context-note mutators that rebuild the prompt

Problems:

- prompt input gathering, session lookup, context-status shaping, and builder invocation are all local
- many mutators repeat “change state then rebuild prompt”

### 5. Compaction frontier and context-budget policy

Methods:

- `handleModelChange()`
- `updateContextTokenTracker()`
- `recordTokenUsage()`
- `shouldCompactBeforeSending()`
- frontier metadata methods
- deprecated previous-context shims

Problems:

- context-budget policy and compaction-frontier persistence are separate concerns but share the same class
- provider-change lifecycle handling is embedded inside model mutation flow

## Existing Test Surface

Current direct coverage:

- `tests/unit/ModelAgentManager.test.ts`
- `tests/unit/ModelAgentManagerContextGating.test.ts`
- `tests/unit/ModelAgentManagerCompactionPersistence.test.ts`

Indirect coverage:

- `tests/unit/ChatSessionCoordinator.test.ts`
- `tests/unit/ChatSendCoordinator.test.ts`
- `tests/unit/ChatSubagentIntegration.test.ts`
- `tests/unit/ContextTrackerCompactionUsage.test.ts`

## Proposed Extraction Targets

### 1. `ModelAgentConversationSettingsStore`

Responsibilities:

- load conversation metadata for initialization
- restore manager state from `chatSettings`
- persist current manager state back to `chatSettings`
- resolve current session id from conversation metadata

Methods likely moved or delegated:

- `initializeFromConversation()` orchestration support
- `restoreFromConversationMetadata()`
- `saveToConversation()`
- `getCurrentSessionId()`

Notes:

- keep actual mutable state in `ModelAgentManager`
- this collaborator should translate metadata to/from a narrow state snapshot

### 2. `ModelAgentWorkspaceContextService`

Responsibilities:

- restore workspace by id
- load full workspace payload
- bind sessions to workspaces
- clear/reset workspace-derived state

Methods likely moved or delegated:

- `restoreWorkspace()`
- `setWorkspaceContext()`
- `clearWorkspaceContext()`

Notes:

- centralize `WorkspaceIntegrationService` usage here
- return a small workspace state result instead of mutating many fields internally where possible

### 3. `ModelAgentDefaultsResolver`

Responsibilities:

- resolve default model
- load plugin defaults for prompt, workspace, notes, thinking, temperature, and agent settings
- resolve provider/model fallback placeholders

Methods likely moved or delegated:

- `initializeDefaults()`
- `initializeDefaultModel()`
- `getSelectedModelOrDefault()`
- `resolveModelOption()`
- `setSelectedModelById()`

Notes:

- this should return a structured defaults snapshot
- `ModelAgentManager` should remain responsible for applying the resolved state and firing events

### 4. `ModelAgentPromptContextAssembler`

Responsibilities:

- gather session/workspace/message-enhancement inputs
- map `ContextTokenTracker` state into `ContextStatusInfo`
- call `SystemPromptBuilder`
- build the final `getMessageOptions()` payload

Methods likely moved or delegated:

- `getCurrentSystemPrompt()`
- `getMessageOptions()`
- `buildSystemPromptWithWorkspace()`

Notes:

- context-note mutators can stay in `ModelAgentManager` initially, but should call one helper instead of rebuilding inline

### 5. `ModelAgentCompactionState`

Responsibilities:

- own `ContextTokenTracker` updates and compaction gating
- own frontier normalization, restore, append, and metadata serialization
- preserve deprecated previous-context shims

Methods likely moved or delegated:

- `updateContextTokenTracker()`
- `recordTokenUsage()`
- `getContextStatus()`
- `shouldCompactBeforeSending()`
- `resetTokenTracker()`
- `isUsingLocalModel()`
- `getContextTokenTracker()`
- frontier methods and metadata helpers

Notes:

- `handleModelChange()` should stay in `ModelAgentManager`, but delegate compaction-policy updates to this collaborator

## Recommended Implementation Order

Completed in this order.

### Phase 0: Characterization coverage

Add focused tests before moving logic:

- `initializeFromConversation()` restores model, prompt, workspace, notes, thinking, temperature, and agent settings from `chatSettings`
- `saveToConversation()` preserves existing `sessionId`
- `setWorkspaceContext()` binds the current session to the workspace and rebuilds the prompt
- `clearWorkspaceContext()` clears loaded workspace data and rebuilds the prompt
- `getMessageOptions()` includes selected model, prompt-derived system prompt, workspace id, session id, thinking, and temperature
- `handleModelChange()` updates compaction policy and notifies WebLLM lifecycle only when provider changes

Status: Complete

### Phase 1: Extract conversation settings persistence

Create `ModelAgentConversationSettingsStore` first.

Why first:

- it removes the highest-risk persistence logic from the main file
- it gives a clean boundary for later workspace/default resolution work

Definition of done:

- `initializeFromConversation()` becomes a thin orchestrator
- `saveToConversation()` becomes a single delegation

Status: Complete via `ModelAgentConversationSettingsStore`

### Phase 2: Extract workspace restore/binding

Create `ModelAgentWorkspaceContextService`.

Why second:

- workspace restore is used from both metadata restore and defaults initialization
- it will collapse repeated `selectedWorkspaceId` / `loadedWorkspaceData` / `workspaceContext` mutation logic

Definition of done:

- there is one place that knows how full workspace data is loaded and sessions are bound

Status: Complete via `ModelAgentWorkspaceContextService`

### Phase 3: Extract defaults/model resolution

Create `ModelAgentDefaultsResolver`.

Why third:

- default model and plugin-setting resolution are still too intertwined with state reset
- this makes the manager easier to reason about before touching prompt assembly

Definition of done:

- `initializeDefaults()` and default restore flow read like state application, not discovery logic

Status: Complete via `ModelAgentDefaultsResolver`

### Phase 4: Extract prompt/message-option assembly

Create `ModelAgentPromptContextAssembler`.

Why fourth:

- by this point session and workspace inputs are already isolated
- prompt-building can become a pure-ish composition step

Definition of done:

- prompt rebuild paths call one shared helper
- `getMessageOptions()` is a thin delegation

Status: Complete via `ModelAgentPromptContextAssembler`

### Phase 5: Extract compaction/context-budget state

Create `ModelAgentCompactionState`.

Why last:

- compaction behavior already has targeted tests and some external callers
- leaving it last reduces regression risk while other state boundaries settle

Definition of done:

- frontier and token-budget logic are no longer mixed with prompt/workspace selection logic

Status: Complete via `ModelAgentCompactionState`

## File Targets

Suggested new files:

- `src/ui/chat/services/ModelAgentConversationSettingsStore.ts`
- `src/ui/chat/services/ModelAgentWorkspaceContextService.ts`
- `src/ui/chat/services/ModelAgentDefaultsResolver.ts`
- `src/ui/chat/services/ModelAgentPromptContextAssembler.ts`
- `src/ui/chat/services/ModelAgentCompactionState.ts`

Suggested new tests:

- `tests/unit/ModelAgentConversationSettingsStore.test.ts`
- `tests/unit/ModelAgentWorkspaceContextService.test.ts`
- `tests/unit/ModelAgentDefaultsResolver.test.ts`
- `tests/unit/ModelAgentPromptContextAssembler.test.ts`
- `tests/unit/ModelAgentCompactionState.test.ts`

## Exit Criteria

- `ModelAgentManager.ts` drops below roughly 650 lines
- `ModelAgentManager` still exposes the same public API used by chat UI/services
- conversation metadata format remains unchanged
- workspace/session binding behavior remains unchanged
- prompt output inputs remain unchanged
- compaction frontier metadata behavior remains unchanged
- targeted Jest coverage exists for each extracted collaborator

Result:

- The first criterion was partially met: the merged result is `784` lines, not under `650`, but it crossed the large-file threshold and now has a clear primary responsibility.
- The remaining behavioral and coverage criteria were met.

## Stop Condition

Stop once `ModelAgentManager` clearly reads as:

- current selection/state holder
- event emitter for model/prompt/system-prompt changes
- top-level facade over the extracted collaborators

Do not keep splitting simple getters/setters once that boundary is reached.

Reached. Further splitting would mostly move small state-forwarding methods without improving the design much.
