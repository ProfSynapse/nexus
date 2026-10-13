# Chat state ownership review

Date: 2026-10-13. Source: `1de19457` (5.20.3). Analysis and proposal only.

## Recommendation

Consolidate active chat state before implementing the accepted thinking disclosure. Extend the existing typed runtime events and pure reducer into a shared runtime owner. Keep durable storage and local view state separate. A new state-management library or a storage rewrite is not a prerequisite.

This review covers foreground chat streaming, reasoning, terminal persistence, UI reconciliation, and adjacent tool/queue paths. It is not a complete audit of every Nexus subsystem, remote-job lifecycle, or multi-device synchronization.

## Evidence

### Reproduced: generation success and persistence failure become contradictory

In `src/services/chat/StreamingResponseService.ts`, the service reduces `turn.completed`, then saves before yielding that event. If saving throws, its catch retains the already-terminal reducer state but creates and emits `turn.failed`. It retries persistence using the retained state.

An isolated fault-injection probe loaded the actual TypeScript service and reducer, with an in-memory conversation repository and fake provider. The first terminal write threw; the second succeeded. Result:

```text
save attempts: 2
stored message state: complete
events received by consumer: assistant.delta, turn.failed
generator throws: injected save failure
```

This proves the service-level control-flow mismatch. It does not establish how often a real installation encounters this failure. Execution outcome and persistence outcome need separate state: a failed save must not retrospectively declare model execution failed, and retrying a save must not rerun generation or tools.

### Reproduced: reasoning lifecycle is incomplete

`src/services/llm/runtime/ChatTurnReducer.ts` closes reasoning segments on answer/tool/response boundaries but changes `reasoning.complete` only for an explicit `reasoning.completed`. Terminal `settle()` changes neither field.

An isolated probe of the actual reducer produced:

| Sequence after reasoning.delta | Turn phase | reasoning.complete | Open segment |
|---|---|---|---|
| assistant.delta | streaming | false | none |
| turn.completed | complete | false | index 0 |
| turn.aborted | aborted | false | index 0 |

The flag can describe a provider marker, but it cannot safely serve as the UI's activity state. Define explicit activity semantics centrally; all terminal outcomes close active reasoning. Preserve the distinction between interrupted reasoning and successful completion. Reasoning may resume after a tool round.

### Confirmed by inspection: persistence errors have inconsistent contracts

`ChatService.updateConversation()` returns `{ success: false, error }` on failure. Callers such as `MessageStateManager.updateMessageContent()` await it without checking success, then notify the UI as though the operation completed. Other lower-level persistence APIs throw. Standardize the contract at the command boundary and require callers to handle failure. A failed prerequisite user-message save should stop dependent generation unless an explicitly designed unsaved workflow exists.

`StreamingResponseService.persistTerminalMessage()` silently returns if the conversation or message is missing. Define this outcome explicitly. A deliberate deletion should not resurrect a message; an unexpected missing target should not count as a successful save.

### Confirmed by inspection: whole-conversation saves have broad authority

`src/services/ConversationService.ts:updateConversation()` treats the supplied message list as a replacement: messages absent from it are deleted, except for an explicit remote-agent-reply exemption. This is intentional replacement behavior, but risky as a routine way to persist one changed message from a UI snapshot.

Use targeted message commands for streaming, abort, edits and accounting. Preserve explicit conversation replacement/deletion operations for callers that actually intend them. Existing `updateMessage()` is a starting point, but its metadata semantics and legacy-backend behavior need review before substitution. This review did not reproduce concurrent data loss.

### Confirmed by inspection: overlapping owners and incomplete event identity

- The backend and UI both run `ChatTurnReducer`, while `MessageStateManager`, `MessageManager`, bubbles and display controllers also mutate/cache message and lifecycle state. Multiple deterministic projections can be valid; independent mutation and phase interpretation are the concern.
- Reasoning reaches the bubble before the UI conversation's reasoning fields are updated at terminal time. Reconciliation therefore needs special treatment to avoid replacing newer presentation with older data.
- `ChatRuntimeEnvelope` identifies only `messageId`; retries can reuse that ID. Add a generation/attempt identity at the runtime boundary and validate it in subscribers and persistence effects. Do not blindly replace existing tool-operation IDs: their idempotency semantics require an explicit mapping.
- `ToolCallStateManager` keys its state by tool-call ID; `MessageQueueService` uses a boolean generation flag. These deserve scoped lifecycle/concurrency tests. This review does not establish a live collision or queue race, nor recommend changing supported concurrency without those tests.

## Preserve existing strengths

- `ChatRuntimeEvent`, `ProviderStreamEventMapper` and `ChatTurnReducer` already separate provider events from turn state and distinguish response completion from whole-turn completion.
- Terminal events are checked for conflicts/idempotence, and missing terminal events are treated as errors.
- The normal success path in `MessageStreamHandler.streamAndSave()` already avoids a second stale UI save. Existing tests protect delayed provider cost updates. Preserve those safeguards.
- Storage guidance defines JSONL as durable truth and SQLite as a rebuildable projection. Keep that boundary; token-by-token disk event logging is unnecessary for this UI work.
- Tool status, provider reasoning signatures, usage accounting and branch semantics have existing responsibilities that a refactor must preserve.

## Proposed ownership

| State | Owner | Consumers |
|---|---|---|
| Active generation: content, reasoning activity, tools, outcome | Runtime service using the existing reducer, keyed by conversation/message/generation | Read-only UI selectors and persistence effects |
| Save status: pending, saving, saved, failed or deliberately discarded | Persistence coordinator for that generation | UI status/recovery and command callers |
| Saved messages, alternatives, conversation metadata | Existing repositories and domain commands | History and durable domain reads |
| Expansion, focus, selection and scroll following | View/component, scoped to generation/alternative | Only that view |

Use one transition path for each live generation. Commands initiate send/cancel/retry; runtime events update its snapshot; subscribers render it. A provider's silence or a markdown parser's existence must not determine whether the model is thinking or a turn is active.

Separate turn outcome, current reasoning activity, per-tool execution and save status rather than adding every combination to one enormous phase enum. Derive view flags such as `isThinking` and `canCancel`; do not store extra mutable copies. Accounting corrections may arrive after generation completes and need a separate authorized update path; do not reopen a finished turn or let an old attempt overwrite a retry.

A runtime store should be owned by the chat service lifecycle, not a bubble. Switching conversations or recreating a view can attach to its latest snapshot. Views own subscriptions and unsubscribe on disposal; closing a view follows an explicit cancellation policy. Evict settled snapshots only after persistence is acknowledged and consumers can rehydrate safely. Keep failed-save recovery bounded and preserve unsaved content while the application remains open. Crash recovery for unsaved content is a separate durability decision, not an automatic promise of an in-memory store.

This is a common ownership pattern across the system, not one global mutable store for all Nexus data. Domain services retain their own state and invariants.

## Staged file plan

1. **Correct lifecycle and save semantics.** Extend `ChatTurnReducer.ts` and its tests with explicit reasoning activity/terminal closure. In `StreamingResponseService.ts`, separate runtime terminal outcome from persistence failure and missing-target outcomes. Standardize checked command results in `ChatService.ts`, `MessageStateManager.ts` and affected abort/retry callers. Add regression coverage before changing behavior.
2. **Introduce the shared runtime owner.** Add `src/services/chat/ChatTurnStore.ts` and a small selector module; names are proposed. Extend `ChatRuntimeEvent.ts` transport context with conversation and generation identity. Let `StreamingResponseService.ts` publish accepted transitions to the store. Define subscription disposal, retry reset and snapshot eviction. Keep provider adapters behind the existing mapper.
3. **Move views to projections.** Migrate `MessageStreamHandler.ts`, `MessageManager.ts`, `ChatView.ts` and `MessageDisplay.ts` to snapshots/selectors. Remove duplicate authoritative mutation once each path moves. A temporary comparison projection may be read-only; never create two persistence writers. Preserve incremental markdown rendering and first-reasoning anchors.
4. **Narrow persistence writes.** Use explicit message updates via `ConversationService.ts` and repository APIs. Audit abort/retry/alternative and cost writers for ordered, generation-scoped effects, checked results and metadata ownership. Preserve late cost updates, remote replies and intentional deletion. Establish serialization/revision checks where multiple commands can affect the same entity; a store alone does not make read-modify-write atomic.
5. **Connect adjacent state deliberately.** Project shared turn identity/activity into tool status and queue admission while retaining tool substep events and priorities. Check `ToolCallStateManager.ts`, `ToolEventCoordinator.ts`, `ToolStatusBarController.ts`, `MessageQueueService.ts` and `SubagentController.ts` for their actual ownership scope before changing keys or queue rules. Avoid coupling current message identity to markdown parser maps.
6. **Implement the accepted accordion.** Follow `thinking-disclosure-implementation-plan.md`, sourcing its display payload from runtime selectors. The component owns expansion and follow behavior only. It adds no new interpretation of provider/turn lifecycle.

Stages can be reviewed and tested separately. Stage 1 is worthwhile independently. Runtime ownership and relevant write boundaries should be stable before wiring the new disclosure; broader subsystem migration need not become a prerequisite to shipping it.

## Verification gates

- Actual reducer: implicit reasoning boundaries, thinking/tools/thinking, reasoning-only success, abort/failure, terminal closure and conflicting terminals.
- Service fault injection: completed generation with first-save failure and retry success; persistent save failure; missing/deleted target; failed prerequisite user-message save. Retrying persistence must execute no provider/tool work.
- Identity/lifecycle: same-message retry ignores old-attempt events; switching conversations and remounting views retains current state; subscription cleanup; supported multi-view/subagent scope.
- Persistence: delayed cost remains intact, unrelated messages are not removed by targeted writes, partial abort is preserved, alternative selection is correct, explicit deletions stay deleted.
- UI: existing tool status remains correct across turns; reasoning follows only while caught up, preserves expansion/reading position, and settles to brain + Reasoning.

Only isolated reducer/service probes were executed for this review, using transpilation and stub dependencies. No model/tool calls, real conversation writes, production code edits, live plugin changes, full suite or build occurred. Implementation requires focused regression tests, bounded broader checks and the repository's real Obsidian test-vault workflow.
