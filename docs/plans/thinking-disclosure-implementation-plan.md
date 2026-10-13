# Implementation Plan: Unified Thinking Disclosure

> Analysis date: 2026-10-13
> Source baseline: `1de19457` (Nexus 5.20.3)
> Status: implemented locally on 2026-10-13 after the user approved proceeding. See [implementation and verification notes](thinking-disclosure-implementation-notes.md). The analysis below records the original baseline.
> Visual contract: `docs/mockups/thinking-disclosure.html` and its same-stem CSS/JS, accepted 2026-10-13 after the **Reasoning + brain icon** revision.

## Foundation prerequisite — revised after state review

The subsequent [chat state ownership review](chat-state-ownership-review.md) supersedes the original UI-only state approach. First correct reasoning lifecycle and save-outcome handling, then expose authoritative generation snapshots from a shared runtime owner. `MessageStreamHandler` must not become a second phase authority, and `MessageDisplay` must not own an independent runtime-state cache. The accepted visual design and local expansion/scroll behavior remain unchanged. Backend files previously listed as unchanged now have scoped prerequisite work in that review.

## Outcome

Replace the separate thinking disclosure and in-message word ticker with one accordion. While thinking, it shows the existing rotating words/icons, an icon pulse and a silver sweep across the word. When reasoning ends, it settles to a static Lucide `brain` icon and **Reasoning**. A chevron is the only visible disclosure affordance. No Show/Hide label, live heading, completion badge, or tool activity belongs in this accordion.

The panel starts collapsed, preserves the reader's choice through streaming and completion, and holds plain-text provider-shared reasoning. A circular down-arrow appears when the reader scrolls away from the end. Following resumes when they reach the end themselves or press the arrow. Tool activity remains in the existing status bar.

The mockup is the implementation reference. Further visual changes follow the mockup revision protocol. The user's subsequent “proceed” authorized local implementation; release and deployment remain separate.

## What the code actually does

- `ThinkingLoader.ts` owns a separate status element, random word/icon rotation every 5 seconds, a 180 ms character timer and a 500 ms dots timer. `stop()` removes the DOM entirely; it cannot currently settle in place.
- `MessageBubble.ts` independently creates a native `details`/`summary` reasoning block. It has no inner scrolling controller. Its `syncReasoningBlock()` sets `textContent` to the entire accumulated string. `updateReasoning()` and `renderBody()` use the message's whole-turn `streaming`/`isLoading` state to decide openness, even when a reasoning-completed event arrived.
- `WorkingIndicatorController.ts` reintroduces the separate ticker during tool activity and after an 800 ms text gap. `ChatView.ts` even routes reasoning updates through `noteToolActivity()`. This is why changing only CSS or the loader would still produce duplicated/misleading activity.
- `MessageStreamHandler.ts` receives typed runtime events but only forwards reasoning deltas and explicit `reasoning.completed` events to the reasoning UI. It updates conversation reasoning fields at terminal events; the bubble separately updates its own copy while streaming.
- `ChatTurnReducer.ts` closes `openSegmentIndex` on answer text, tool events and response completion, but **does not set `reasoning.complete = true` for those boundaries**. Its terminal `settle()` changes turn phase without closing reasoning. A UI driven solely by `reasoning.complete` can keep animating after thinking stops.
- `ReasoningSegmentSplitter.ts` already combines multiple reasoning runs into **one disclosure per turn**, positioned at the first reasoning offset. Some comments in the bubble, streaming controller and chat types still describe multiple visible blocks. Preserve the current one-block behavior, not the stale comments.
- `StreamingController.ts` correctly binds markdown parsers to `.message-turn-text`, keeping reasoning outside the parser. It also contains ticker-placement exceptions and an unused `showAILoadingState()` path that empties the entire message body.
- `MessageDisplay.ts` already protects the transcript's independent follow state and ignores nested scroll events. It reconciles existing bubbles on every conversation update; each bubble currently empties and rebuilds its body. This makes stable component ownership and state restoration essential.

## State and event contract

Separate three independent concerns: **reasoning activity**, **accordion expansion**, and **scroll following**. A phase update must not reset the latter two.

Proposed transient UI payload:

```ts
type ReasoningDisplayPhase = 'waiting' | 'thinking' | 'settled' | 'interrupted';

interface ReasoningDisplayState {
  phase: ReasoningDisplayPhase;
  text: string;
  segments?: ReasoningSegment[];
}
```

Replace the internal four-argument reasoning callback with `onReasoningUpdate(messageId, state)`. This is a view projection of the shared runtime snapshot, not persisted animation state. Include the runtime generation identity in delivery/reset handling so retries that reuse a message ID cannot accept stale updates. Emit initial waiting state from the runtime lifecycle, not an independent UI phase tracker.

| Event | Accordion behavior |
|---|---|
| New request | Waiting animation; collapsed on a new generation; honest empty explanation if opened. |
| Nonblank `reasoning.delta` | Append/update content and animate; retain open/closed choice and reading position. |
| `reasoning.completed` | Settle to brain + Reasoning. |
| `assistant.delta`, tool-call snapshot/execution, `response.completed` | End active reasoning if an explicit end was omitted; retain collected reasoning without showing tool labels. Ignore empty/no-op snapshots as activity. |
| More reasoning after a tool round | Animate the same disclosure again; retain previous reasoning. |
| `turn.completed` | Stop all active animation, retain collected reasoning. |
| `turn.aborted` / `turn.failed` | Stop animation; retain partial reasoning and the mockup's interrupted treatment; preserve expansion. Existing error/retry UI remains responsible for the error. |
| Reopen a completed historical message | Static brain + Reasoning, initially collapsed. No timers. |

Emit state changes before answer-token rendering where relevant; coalesce redundant non-content updates. Ignore whitespace-only reasoning as evidence of an actual thought. Provider identifiers/encrypted/signed blocks remain untouched.

**Edge policy proposed for implementation:** the waiting row is transient. If the model answers or begins tools without ever sharing reasoning, remove that empty waiting row; do not archive an empty Reasoning accordion. While initially waiting, opening the row explains that no text has arrived. If reasoned content arrives later, insert its disclosure at the existing first-reasoning anchor. This avoids permanent empty panels and claiming tool execution is thinking. No new provider capability setting is needed.

## File-by-file changes

### 1. Add `src/ui/chat/types/ReasoningDisplayState.ts`

Define the UI-only payload and phase union above. Import `ReasoningSegment` as a type. Do not add animation, expansion, scroll position, or timestamps to `ConversationMessage`, JSONL, or provider request history.

### 2. Update `src/ui/chat/services/MessageStreamHandler.ts`

Make this a compatibility adapter from authoritative runtime snapshots/selectors to the view callback. Interpret implicit reasoning boundaries and terminal events once in the runtime layer; do not add a per-stream UI phase variable. Deliver snapshots on relevant text/phase changes, including initial waiting state.

Build the active message projection from the runtime snapshot during reconciliation so a stored conversation snapshot cannot replace newer streaming reasoning. Any transitional mutation of the UI conversation is a derived compatibility projection, not a second source of truth. Terminal persistence belongs to the shared effect owner, with save status distinct from generation outcome.

Ensure exceptions and malformed-stream exits are also settled by the existing error/abort cleanup path; a finally-based UI stop is a fallback, not a fabricated successful terminal event. Preserve cost, tool, usage, stop-reason and provider metadata behavior.

### 3. Update `src/ui/chat/services/MessageManager.ts`

Change `MessageManagerEvents.onReasoningUpdate` to the shared payload and relay it to/from `MessageStreamHandler`. Keep normal send and alternative/retry paths on the same stream handler. No second phase tracker belongs here.

`MessageAlternativeService.ts` already receives the shared stream handler, so its stream path should not need a second reasoning callback. Verify its clear-and-restream reset and restoration paths; change it only if tests expose missing generation reset notification.

### 4. Update `src/ui/chat/ChatView.ts`

Route the typed reasoning snapshot directly to `MessageDisplay`. Remove `noteToolActivity()` from reasoning handling and remove the in-bubble working-indicator wiring entirely. Keep `ToolEventCoordinator.beginTurn()`, tool detection/start/completion forwarding, and `clearToolNameCache()` intact: removing the old ticker must not break second-turn tool status subscriptions.

Retain the markdown text-run boundary only when the first real reasoning anchor appears after answer text. An already-existing waiting element must not falsely imply the text run was already sealed. Returning a flag named for insertion/anchoring, rather than user expansion, makes this distinction explicit.

Retain terminal cleanup from the loading lifecycle as a safety net for failures that occur outside the normal stream loop. A generic loading-end notification must not overwrite an already-known interrupted state with a successful resting state.

### 5. Update `src/ui/chat/components/MessageDisplay.ts`

Subscribe to and route the shared runtime snapshot for the active conversation/generation. Rehydrate same-message rebuilds and conversation switches from that owner; do not keep an independent authoritative reasoning cache or guess from `isLoading`. Reset local component state on generation/alternative identity changes, handle message-ID remapping through runtime identity, and unsubscribe on disposal.

Remove `showWorkingIndicator()` / `hideWorkingIndicator()` after their callers are gone. Continue forwarding layout growth to the existing outer transcript follow mechanism; preserve the target check that ignores inner panel scrolls. The down-arrow belongs only to the reasoning viewport, not the transcript.

When an expanded reasoning panel is paused on an older passage, temporarily inhibit outer auto-follow through an explicit component callback. Keep this hold separate from the transcript's own `stickToBottom` flag: effective following is `stickToBottom && !reasoningReadHold`. Release the hold when the panel catches up, closes, or is removed. The inner down-arrow must never override a reader who independently scrolled the outer transcript upward. This prevents answer streaming below the panel from carrying an older passage out of view while retaining the current outer scroll policy.

### 6. Add `src/ui/chat/components/ReasoningDisclosure.ts`

An Obsidian `Component` owns one accordion, its header loader, content text node and follow controller. Use the mockup's semantic button with `aria-expanded`/`aria-controls`, a unique controlled panel ID, `setIcon()` for chevron/brain/arrow, and native Enter/Space activation. The cosmetic changing words are hidden from assistive technology; the stable accessible label is Thinking while active and Reasoning when settled. Do not announce every word or token through a live region.

Expose a small surface: mount/reattach, update snapshot, capture/restore view state, reset for a different generation/alternative, and dispose. Expansion and inner scroll state are local and must survive routine reconciliation. Loading a different historical message can use the default collapsed state; persistence across application restarts is out of scope.

Reuse `ThinkingLoader` for the header animation and resting presentation. Render reasoning as plain text, not HTML or markdown. When the normalized next string extends the previous one, append only its suffix to the existing text node. If normalization, retry or a real replacement changes the prefix, perform an explicit replacement while restoring the valid scroll position. Never append by raw provider-delta length because the splitter normalizes newlines and joins segments.

All events use `registerDomEvent`; child components use `addChild`/`removeChild` with a clear owner. Cancel observers, animation frames, timers and media-query listeners when disposed. Use the element's owning document/window for popouts and avoid cross-window `instanceof` assumptions.

### 7. Add `src/ui/chat/controllers/ReasoningScrollController.ts`

Own only the reasoning viewport's `following`, last position, pending frame and resize observer. Keep it separate from the transcript's existing 64 px threshold. The mockup's 8 px inner tolerance is the starting value.

Algorithm:

1. Capture whether the reader is at the bottom **before** appending content.
2. Append/update text, then coalesce the follow write to one animation frame. Recheck user scroll intent before that frame writes.
3. If following, scroll to the new end; otherwise preserve the reading position and show the arrow when content remains below.
4. A genuine scroll up pauses following; reaching the bottom resumes it. Content growth, anchoring and programmatic scrolling must not impersonate a reader gesture.
5. The arrow moves to the end, resumes following and restores focus to the reasoning viewport without scrolling the outer transcript.
6. Collapsing records the position. Ignore zero geometry while hidden; reopening restores the old position or follows the end according to the prior mode.
7. Width/font/viewport changes keep a following reader pinned. Preserve a paused reader's position as far as the new geometry permits. Disconnect observation and cancel frames on teardown.

The arrow is an absolutely positioned 44 px circular button with a down-arrow, tooltip and accessible name. Its visibility must not change the scrollable height; otherwise showing it can itself move the reader away from the bottom.

### 8. Update `src/ui/chat/components/MessageBubble.ts`

Replace the independent `reasoningBlock`, auto/user maps and working-ticker ownership with one `ReasoningDisclosure` child. Keep message layout, source footer, image rendering, branch navigation and answer actions intact.

`renderBody()`, `updateReasoning()`, `updateContent()` and `updateWithNewMessage()` must share the same component/state. During a same-answer rebuild, capture state and preserve/reattach the disclosure instead of silently creating a fresh one. Do not infer thinking activity from the whole-turn `streaming` flag. On a retry or alternative change, reset the appropriate view state; routine redraws or temporarily absent reasoning must not be mistaken for a retry.

Maintain one semantic first-reasoning anchor separate from existence of a pre-token waiting row. Preserve text before that anchor and all later answer runs. Keep original/alternative reasoning isolation through `MessageBubbleStateResolver`; live updates to the generating answer must not overwrite an older alternative the user is inspecting.

Make terminal animation cleanup idempotent and preserve the panel/text. The existing public `stopLoadingAnimation()` is used by abort handling; either retain it as a compatibility entry point that settles the new component or rename it together with `ChatSendCoordinator` and its tests. Preferred first pass: retain the method and remove its obsolete dots/ticker internals.

### 9. Update `src/ui/chat/components/ThinkingLoader.ts`

Convert it from a disposable standalone ticker to a reusable header presentation. Add an idempotent active/resting mode: active rotates full words/icons using the existing word catalogue; resting cancels timers and renders `brain` + `Reasoning` without removing the header.

Remove character-by-character typing and the dots timer; the approved motion is the silver sweep and icon pulse. Keep one 5-second word rotation timer. Repeated token updates must not restart it. CSS handles continuous motion. Reduced-motion mode has no pulse, sweep or rotating words; respond if the preference changes while open.

Reserve `stop()`/unload for destruction or a clearly documented stop contract; distinguish settling from DOM removal. Remove the current frequently changing `role=status`/`aria-live` announcement behavior from cosmetic words.

### 10. Remove `src/ui/chat/controllers/WorkingIndicatorController.ts`

After all callers are migrated, remove the controller whose sole purpose is the separate in-bubble gap/tool ticker. Its 800 ms silence heuristic is not evidence of reasoning. Initial waiting is handled by the unified disclosure and tool progress by the status bar. Remove its obsolete tests with it and retain replacement coverage for the user-visible guarantees.

### 11. Update `src/ui/chat/controllers/StreamingController.ts`

Keep markdown parsing confined to `.message-turn-text`. Remove `.ai-loading-continuation` placement/skip branches once that element no longer exists. Retire the unused `showAILoadingState()` method that empties `.message-content`, or route it through the single owner if a newly discovered caller needs it. Do not remove `stopLoadingAnimation()` indiscriminately: `ChatSendCoordinator` still calls that legacy cleanup API.

Correct comments describing multiple visible thinking blocks. Preserve the existing synchronous parser-map cleanup and detached-run recovery; the tool status controller relies on the current-message ID being cleared at completion.

### 12. Update `styles.css`

Replace the old left-rule/native-summary treatment around the `.message-reasoning` rules with the accepted accordion, bounded text viewport, chevron, focus ring and circular arrow. Add the pulse and silver text sweep in the `.thinking-loader` section. Use state classes/data attributes scoped to reasoning; do not reuse or change the tool status bar's `shimmer-sweep` keyframes.

Use Obsidian theme variables and Nexus spacing tokens. Define a theme-aware silver highlight and its light-theme treatment; do not copy the mockup's entire hardcoded theme block. Reduced-motion rules must remove text clipping/transparency as well as animation so the words remain readable. Preserve mobile left alignment and 44 px targets. No inline styles, remote fonts, heavy filters or JS animation loop.

## Files reviewed that should retain their behavior

- `src/ui/chat/constants/thinkingWords.ts`: reuse the full existing word/icon catalogue and substitutions. The mockup's four words are examples, not a replacement list.
- `src/ui/chat/components/helpers/ReasoningSegmentSplitter.ts`: keep normalization, original offsets and one-display-block semantics. Its output is what the new component displays.
- `src/ui/chat/components/helpers/MessageBubbleStateResolver.ts`: keep active-alternative resolution; add regression coverage rather than bypassing it.
- `src/services/llm/runtime/{ChatRuntimeEvent,ChatTurnReducer,ProviderStreamEventMapper}.ts`: retain the event/mapper architecture. The foundation prerequisite now extends transport identity and reducer lifecycle semantics; see the state ownership review for scope and tests.
- `src/types/chat/ChatTypes.ts`, provider adapters and reasoning persistence: no schema migrations, timing fields, or rewrites of signed thinking. Stale explanatory comments may be corrected separately from behavior.
- `src/ui/chat/coordinators/ToolEventCoordinator.ts`, `controllers/ToolStatusBarController.ts`, `components/ToolStatusBar.ts`: keep tool labels and per-turn subscription lifecycle. Runtime identity/subscription wiring may change in the foundation stage; the status bar's presentation remains outside the accordion redesign.
- `src/ui/chat/services/MessageAlternativeService.ts`, `utils/AbortHandler.ts`, `services/ChatSendCoordinator.ts`: preserve intended retry/abort behavior while migrating ownership and checking save results in the foundation stage. Preserve partial responses and selected alternatives; avoid stale full-conversation writes.

## Test file map

| File | Change / regression to prove |
|---|---|
| Add `tests/unit/ReasoningDisclosure.test.ts` | Starts collapsed, whole-row keyboard activation, stable DOM/state through updates, single panel, plain-text handling, brain + Reasoning at rest, no tool/live/action labels, cleanup. |
| Add `tests/unit/ReasoningScrollController.test.ts` | Pin before growth; pause; manual and arrow catch-up; queued-frame user scroll race; hidden-panel geometry; resize; dispose. Simulated geometry proves decisions, not browser layout. |
| Update `tests/unit/ThinkingLoader.test.ts` | Fake-timer lifecycle, single rotation timer, no token-induced resets, settled brain/label, resume, icon fallback and reduced motion. Remove obsolete typewriter expectations. |
| Update `tests/unit/MessageBubble.test.ts` | Replace default-auto-open/terminal-auto-close expectations with collapsed default and user-choice preservation. Cover reconcile, first real anchor after answer text, same-ID retry, alternatives, terminal and reasoning-only turns. |
| Update `tests/unit/MessageDisplay.test.ts` | Snapshot relay/hydration/key migration and reset; nested scroll does not mutate transcript stickiness. Explicit paused-panel hold suppresses outer following until catch-up/collapse; inner catch-up never overrides manual outer scrolling. Keep existing outer-follow regressions. |
| Update `tests/unit/MessageStreamHandler.test.ts` | Reasoning → answer without explicit completed; reasoning → tools → reasoning; response end vs turn end; terminal/exception/abort; in-memory reasoning survives reconcile; no-reasoning request; callback payload migration. |
| Update `tests/unit/ChatViewToolTickerWiring.test.ts` | Remove assertion requiring `workingIndicatorController.begin()`. Preserve beginTurn/clearToolNameCache protection. Add no reasoning-to-tool-activity wiring guard where appropriate. |
| Remove `tests/unit/WorkingIndicatorController.test.ts` | The old gap ticker is removed; replace its relevant initial-wait/terminal guarantees in the new component and handler tests. |
| Extend `tests/unit/StreamingControllerCurrentMessageId.test.ts` | Parser initialization/finalization never clears the disclosure; first-reasoning-after-text and detached-run recovery remain intact. |
| Add `tests/manual/thinking-disclosure-e2e.md` | Real Obsidian checklist: theme, touch, popout, keyboard, selection, streaming, scroll, retry, abort, reopen and multi-tool rounds. |
| Update `tests/manual/glass-variant-e2e.md` | Replace outdated standalone loader instructions with a link to the new procedure; do not leave a manual checklist demanding deleted UI. |

Run existing `ReasoningSegmentSplitter`, `ReasoningPersistence`, `ChatTurnReducer`, `ProviderStreamEventMapper`, alternative/abort/send coordinator and tool status pipeline tests as regressions. `ChatSendCoordinator.test.ts` needs edits only if the public cleanup method is renamed. Update narrowly scoped mock DOM support only where required; do not let fake geometry or icon mocks decide the integration result. Existing mocks/tests contain historical API assumptions, so establish a baseline before attributing failures to this work.

## Implementation sequence and proof

1. Baseline the focused suites and typecheck in the isolated worktree. Keep parallelism bounded (`--maxWorkers=2`), use the machine's pnpm workflow, and do not borrow another checkout's writable dependencies.
2. Complete the relevant foundation stages in `chat-state-ownership-review.md`: lifecycle/save semantics, shared runtime ownership and identity, checked targeted persistence, and read-only UI projections. Then add the display contract and selector tests. Do not implement the earlier standalone UI phase tracker.
3. Build the disclosure, scroll controller and reusable header modes; prove their behavioral regressions.
4. Integrate bubble/display/view ownership; remove the obsolete ticker; preserve tool status and markdown boundaries.
5. Port styles, then validate the approved visual states in both themes and narrow widths.
6. Run focused regressions, typecheck/lint/mobile reachability, the full non-opted-in test suite with bounded workers, and the production build. Run the testing skill's live-lane/catalog checks. These commands are planned, not executed by this analysis task.
7. Verify the built plugin in an explicitly selected test vault using the Nexus testing skill's Obsidian CLI loop. Do not install into or reload the user's working vault merely to test. Exercise actual asynchronous growth, native scrolling, keyboard focus, theme switching, popouts, aborted thinking-only turns, and thinking/tools/thinking cycles. A browser mockup or green mocked Jest suite does not prove Obsidian behavior.

Deliberately break the phase settlement and pre-append follow check once while writing tests, confirm the corresponding tests fail, then restore. Those are the two most likely defects to escape an implementation that only copies the mockup's appearance.

## Analysis completion

The later state review changes the prerequisite scope; its isolated service/reducer probes and findings are recorded separately. This document records the accepted visual contract and proposed implementation. No production files, provider code, storage, running plugin or tests were changed or executed for this analysis. Remaining uncertainty is real Obsidian layout/lifecycle behavior, which belongs to the implementation verification step rather than a new product control.
