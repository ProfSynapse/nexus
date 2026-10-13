# Shared chat runtime and reasoning disclosure

Implemented locally on 2026-10-13 in `design/thinking-disclosure`, based on `1de19457` (5.20.3). References: [state ownership review](chat-state-ownership-review.md), [file plan](thinking-disclosure-implementation-plan.md), and [accepted mockup](../mockups/thinking-disclosure.html).

## Result

Foreground chat now has a service-owned runtime snapshot for each conversation, message and generation. Generation outcome and save outcome are independent. A successful response stays successful when persistence fails; the UI offers **Retry save**, which retries storage without repeating model or tool work. Failed prerequisite user-message writes stop generation. Routine writes target the affected message instead of submitting a stale replacement conversation.

The thinking UI is one native accordion: familiar rotating words, pulsing icon, silver sweep, and a chevron. After reasoning ends it settles to a static brain icon and **Reasoning**. It starts collapsed, preserves the reader's choice, and contains only reasoning. Tool activity remains in the status bar. The inner panel follows while caught up, pauses when scrolled upward, and resumes at the bottom or through its circular down-arrow. A paused inner panel temporarily inhibits transcript following without changing the transcript's independent scroll intent.

## Ownership and changed files

| Area | Implementation |
| --- | --- |
| Runtime | New `ChatTurnStore.ts` owns snapshots, generation identity, save status, subscriptions and bounded retention. `ChatTurnReducer.ts` closes reasoning at implicit boundaries and terminal outcomes. `ChatRuntimeEvent.ts` carries the snapshot. |
| Streaming and persistence | `StreamingResponseService.ts` performs the production reduction once, guards stale callbacks and orders terminal persistence and delayed accounting. It attempts a terminal write twice before exposing explicit save recovery. `ChatService.ts` exposes runtime/retry access and overlays active or unsaved state on reads. |
| Targeted writes | `ConversationService.ts` serializes targeted message writes per conversation, rejects missing targets and preserves accounting metadata. `CostTrackingService.ts` uses this path for accounting. JSONL remains durable truth; no schema or storage-root changes. |
| Commands | `MessageStateManager.ts`, `MessageManager.ts`, `MessageAlternativeService.ts` and `AbortHandler.ts` handle checked save results and avoid a second terminal writer. A failed save must be resolved before starting another turn in that conversation. |
| Queue and tools | `MessageQueueService.ts` tracks active generation IDs. `ToolStatusBarController.ts` reads runtime message identity instead of relying on markdown parser identity. Existing tool event and subagent services retain their responsibilities. |
| Projection | `MessageStreamHandler.ts` consumes production snapshots; `MessageDisplay.ts` subscribes and hydrates reconciled bubbles. `ChatView.ts` wires subscriptions and storage-only recovery. `StreamingController.ts` retains incremental markdown parsing while obsolete loading/ticker paths are removed. |
| Disclosure | New `ReasoningDisclosure.ts` owns the native details element and stable text node; new `ReasoningScrollController.ts` owns follow intent. `MessageBubble.ts` preserves the component and its scroll position across reconciliation. `ThinkingLoader.ts` and `styles.css` implement active/settled visuals and reduced-motion rules. The old `WorkingIndicatorController.ts` is removed. |

Legacy injected event producers without a snapshot retain a reducer compatibility path. Older injected repositories retain a whole-conversation fallback. The real application path uses the shared store and targeted message method; these seams do not create a second production runtime owner.

## Verification

- Regression tests first reproduced five failures in reasoning boundaries and save outcomes, then passed after the fixes (`/tmp/nexus-state-red.log`). A mutation of upward-scroll handling made its regression fail before restoration (`/tmp/nexus-scroll-mutation.log`).
- Full default Jest run: **489 suites passed; 6,115 tests passed; 89 skipped**. Gated live lanes remain intentionally skipped by default (`/tmp/nexus-complete-suite.log`).
- `pnpm run build` passed, including type checking, lint, mobile import reachability and bundling (`/tmp/nexus-final-build.log`). No dependency manifest change is required.
- The full suite emitted a worker teardown warning. A focused run of the touched UI suites with `--detectOpenHandles --runInBand` passed 45 tests without reporting open handles (`/tmp/nexus-handle-check.log`). This does not establish the cause of the full-suite warning.
- Real Obsidian, with this bundle installed only into an isolated disposable vault: the gated [live smoke test](../../tests/debug/thinking-disclosure-live-smoke.test.ts) passed after a clean application reload (`/tmp/nexus-live-clean.log`). It exercises native Enter activation, computed animation state, actual inner scroll geometry, paused reading, reconciliation, catch-up, completion, subscription holds and persistence through the real send pipeline. Only the provider stream is synthetic; it makes no paid model calls.
- The live test exposed and verified a fix for an ancestor DOM reappend resetting scroll position at completion, a behavior the mocked DOM did not reproduce.
- The official **Nexus: Rebuild cache** command completed in that disposable vault. A subsequent lower-level `ConversationService` read, bypassing runtime overlays, retained `Verified answer.`, 2,480 reasoning characters and the reasoning segment for fixture `a368e3d8-f67b-4187-8a51-8b87daad1c9c`.
- Live-lane gates, test catalog and storage schema checks passed. Skill validation passed for testing and mobile compatibility. The generic storage-skill validator flags three existing repo-relative documentation references; the referenced plan files exist in `docs/plans/`. This patch only appends skill refinement logs and syncs their mirrors.

## Remaining boundaries

The store retains failed saves in memory; it is not a crash-recovery journal. This is a foreground chat ownership refactor, not a complete migration of all Nexus state or an audit of distributed writes, every conversation-selection race, or every subagent lifecycle. Mobile verification is static import analysis, not a physical-device test.

The disposable vault also logged a `UNIQUE constraint failed: workspaces.name` error from existing default-workspace initialization after reload. That path is unchanged and has not been diagnosed by this patch; it deserves a separate investigation. No uncaught errors were captured by Obsidian's `dev:errors` during the final live check.

Source, tests, mockup and review notes remain in the isolated worktree. The user's working vaults were not upgraded, and no commit, push, release or deployment was performed. Temporary `/tmp` logs are local evidence, not durable published artifacts.

## User-authorized installation — 2026-10-13

After the implementation handoff, the user explicitly requested installation in Professor Synapse and a restart for testing. Installed the verified `main.js`, `styles.css`, `manifest.json` and `sqlite3.wasm` into that vault's Nexus plugin directory, with SHA-256 equality verified against the worktree artifacts. Preserved plugin settings and vault data. Previous artifacts are backed up outside the vault at `/home/profsynapse/.local/share/nexus-plugin-backups/professor-synapse/20261013T163705Z`.

Reloaded Nexus in the explicitly verified Professor Synapse renderer. Confirmed a new plugin instance, ready chat service and the new shared runtime. The CLI requires the vault selector before the command on this installation; an initial trailing-selector read routed to another renderer and was stopped by an in-band identity assertion before any mutation. This is a local test installation, not a Git release.

## User refinement — typed words and ellipsis

The user requested restoring the previous typing animation after trying the installed build. `ThinkingLoader.ts` again reveals one letter every 180 ms, followed by a 500 ms cycling ellipsis. Word rotation, silver sweep and icon pulse remain. Reduced-motion preference shows the complete label immediately. Settling clears both animation timers before displaying brain + Reasoning. Two focused regressions prove typing and dot timers cannot overwrite that final label; they failed against the whole-word implementation before restoration.

Typing refinement verification: production build passed; 6,117 tests passed (89 skipped), with the previously observed full-suite worker teardown warning. Installed in Professor Synapse and verified a new, ready plugin instance. Previous installed artifacts backed up at `/home/profsynapse/.local/share/nexus-plugin-backups/professor-synapse/20261013T165643Z`.

A detached DOM probe using the actual loaded Obsidian component confirmed gradual letters, cycling dots and a stable settled label. It used a new loader instance, disposed it afterward, and did not alter conversation data.

## User refinement — keep activity through the whole generation

The user requested that the header keep animating through tool execution and answer streaming, settling to brain + Reasoning only when the whole turn ends. `selectReasoning` now derives header activity from turn outcome, while the reducer still closes reasoning segments at their original boundaries. The disclosure body remains reasoning-only. Completed, aborted and failed turns stop animation independently of save status. The real-store regression exercises explicit reasoning completion, response/tool boundaries, tool execution, resumed reasoning, answer streaming and terminal completion.

Verification: production build and all 6,117 tests passed (89 skipped; existing full-suite teardown warning remains). Installed and reloaded in Professor Synapse, backing up the previous artifacts at `/home/profsynapse/.local/share/nexus-plugin-backups/professor-synapse/20261013T172854Z`. A detached probe using the loaded real store, bubble and disclosure confirmed activity across nine reasoning/tool/answer/terminal events, reasoning-only body content and the final static label. No conversation data was written by the probe. This follow-up is local on `fix/thinking-through-generation`, based on merged PR #413; it has not been published.
