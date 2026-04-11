# Manual E2E Test Plan: Mobile Chat Glass Migration (Phase 1 Chrome)

> **Date**: 2026-04-11
> **Branch**: `feat/mobile-chat-glass-phase1`
> **Scope**: Phase 1 chat chrome — ToolStatusBar, ContextBadge, ThinkingLoader,
>           ToolInspectionModal, agent-status slot, task-board icon, faux-glass material
> **Plan**: `docs/plans/mobile-chat-glass-migration-plan.md`
> **Unit coverage**: 85 tests in `tests/unit/{ToolStatusBar,ContextBadge,
>                    ThinkingLoader,ToolInspectionModal,ToolStatusBarController,
>                    ToolEventCoordinator}.test.ts`

This document covers what unit tests cannot — the DOM rendering pipeline,
theme/platform rendering, real timer behavior, and cross-slot layout effects.

---

## Prerequisites

1. **Build**: `npm run build` must succeed with zero errors on
   `feat/mobile-chat-glass-phase1`
2. **Obsidian**: v1.5.0 or later (manifest.minAppVersion = 1.5.0)
3. **Devices**: At least one desktop (macOS or Windows) and one mobile
   (iOS **and** Android strongly preferred — see §6 and §7)
4. **Themes to test**: Default (dark), Default (light), Minimal (light),
   Minimal (dark), at least one third-party high-contrast theme
5. **Vault**: A vault with ≥3 conversations that include tool calls
   (to exercise inspection modal pagination)
6. **Reduced motion**: System-level `prefers-reduced-motion: reduce`
   toggle accessible (macOS: System Settings → Accessibility → Display →
   Reduce motion; iOS: Settings → Accessibility → Motion → Reduce Motion)

---

## Test Matrix Overview

| Area | Tests | Priority |
|------|-------|----------|
| §1  Glass material rendering | T1.1 – T1.4 | P0 |
| §2  ToolStatusBar slots & tense mapping | T2.1 – T2.5 | P0 |
| §3  ContextBadge state thresholds | T3.1 – T3.3 | P0 |
| §4  ThinkingLoader lifecycle | T4.1 – T4.3 | P1 |
| §5  ToolInspectionModal pagination | T5.1 – T5.5 | P0 |
| §6  iOS mobile-specific | T6.1 – T6.3 | P0 |
| §7  Android mobile-specific | T7.1 – T7.2 | P1 |
| §8  `prefers-reduced-motion` | T8.1 – T8.2 | P0 |
| §9  Subagent isolation (no-leak) | T9.1 – T9.2 | P0 |
| §10 Theme cross-compat | T10.1 – T10.3 | P1 |
| §11 Task-board icon wiring | T11.1 – T11.2 | P1 |

Completion criteria: All P0 tests pass on at least desktop + iOS.
P1 tests pass on desktop minimum; mobile P1 exercised if time permits.

---

## §1 — Glass Material Rendering

### T1.1 — Faux-glass does NOT use `backdrop-filter`

**Priority**: P0

**Why**: The plan explicitly rules out `backdrop-filter` to eliminate
Android rendering quirks and avoid iOS Safari hit-test bugs. The glass
must be layered color cues on an opaque-ish fill (plan §3).

**Steps**:
1. Open chat view on desktop
2. Inspect the `.tool-status-bar` element in devtools
3. Check computed styles

**Expected**:
- `backdrop-filter` is **NOT** applied (should be `none` or absent)
- Background uses `color-mix(in srgb, ...)` with solid opacity ≥ 0.6
- A top inset highlight (light border-image or gradient) is visible
- Element does not flicker or ghost when scrolling the chat panel above it

**Fail if**: any `backdrop-filter: blur(...)` or `-webkit-backdrop-filter`
is present on any Phase 1 chrome element.

---

### T1.2 — Glass adapts to light/dark theme via `color-mix()`

**Priority**: P0

**Steps**:
1. Open chat view in dark theme — screenshot the status bar and context badge
2. Settings → Appearance → switch to light theme
3. Return to chat view — do NOT reload

**Expected**:
- Status bar background shifts to a light-themed tint without requiring
  reload (the CSS variable system flips automatically)
- Text remains readable (WCAG AA 4.5:1 contrast at minimum)
- ContextBadge color also adapts — greens and reds remain distinguishable
  in both themes
- No hard-coded hex colors leak through (everything should resolve via
  `var(--background-*)` + `color-mix`)

---

### T1.3 — Layered highlights (inset + rim + top-sheen)

**Priority**: P0

**Steps**:
1. Screenshot the ToolStatusBar at 2× zoom in dark mode
2. Identify visible light cues

**Expected** (plan §3):
- A **top inset highlight** along the upper edge of the bar
- A **rim highlight** around the outer edge
- A **top-sheen gradient** (subtle lightening in the upper third)
- A **drop shadow** beneath the bar lifting it off the background

All four effects should be simultaneously visible — this is what sells
the "glass" look without `backdrop-filter`.

---

### T1.4 — No flickering on scroll

**Priority**: P0

**Steps**:
1. Open a long conversation (≥20 messages)
2. Scroll the chat panel rapidly up and down for 10 seconds
3. Observe the status bar and context badge

**Expected**:
- No flickering, ghosting, or paint-tearing on the status bar
- ContextBadge percentage text does not flash or re-render

**Fail if**: any visible paint artifact on the chrome elements.

---

## §2 — ToolStatusBar Slots & Tense Mapping

### T2.1 — All four meta buttons render

**Priority**: P0

**Steps**:
1. Open the chat view
2. Inspect the `.tool-status-bar .tool-status-row--meta` row

**Expected** — four buttons present in this exact order:
1. `.tool-status-inspect-icon` (eye icon)
2. `.tool-status-task-icon` (task-board icon)
3. `.nexus-agent-status-button` (agent slot)
4. `.tool-status-compact-icon` (compact icon)
5. `.tool-status-cost` (cost label, read-only — not a button)

All buttons must have tap targets ≥ 24×24 CSS pixels and ≥ 8px spacing
between them (WCAG 2.5.5).

---

### T2.2 — Tense mapping: present → past → failed

**Priority**: P0

**Steps**:
1. Send a message that triggers a read tool: "Read the note `Welcome.md`"
2. Watch the status bar row 1 text

**Expected**:
- While the tool is running: "Reading Welcome.md" (**present** — `state: present`)
- When it completes: "Read Welcome.md" (**past** — `state: past`)
- If you force a failure (delete the file mid-read or send a bad path):
  "Failed to read {path}" (**failed** — `state: failed`)

Status bar **should NOT** update during the 400ms debounce window with
rapid-fire updates — only the first call fires immediately, the rest
are suppressed until the window closes.

---

### T2.3 — Slot-machine style updates on rapid tool calls

**Priority**: P1

**Steps**:
1. Send a message that triggers many tool calls in sequence (e.g.,
   "Search for X, read the top 3 results, then summarize")
2. Watch the row 1 label

**Expected**:
- Label updates smoothly between tools (no visible flicker)
- Debounce prevents more than one update per 400ms
- Final label reflects the most recent tool call's state

---

### T2.4 — Status bar hidden by default

**Priority**: P1

**Steps**:
1. Create a new empty conversation
2. Inspect `.tool-status-bar`

**Expected**:
- `.tool-status-bar-hidden` class is applied
- Element has `display: none` or `visibility: hidden` (via CSS class)
- Becomes visible only on first `pushStatus()` call

---

### T2.5 — Agent status slot lifecycle

**Priority**: P1

**Steps**:
1. Dispatch a subagent (via `/@`)
2. Watch `.nexus-agent-status-button`
3. When subagent terminates, check the slot again

**Expected**:
- Slot is populated with the agent's status during execution
- Slot empties back to the idle state on agent termination
- No orphaned DOM nodes remain after agent cleanup

---

## §3 — ContextBadge State Thresholds

### T3.1 — State transitions at plan-specified boundaries

**Priority**: P0

Plan thresholds: SAFE=49, WARM=74, HOT=89, DANGER=100

**Steps**:
1. Open a conversation with a known context usage
2. Force percentage values via devtools: `document.querySelector('.context-badge').dispatchEvent(...)` or monitor via natural conversation growth
3. Observe the badge color/class at these percentages:
   - 30% → `safe` (green)
   - 49% → `safe` (boundary)
   - 50% → `warm` (amber begins)
   - 74% → `warm` (boundary)
   - 75% → `hot` (orange)
   - 89% → `hot` (boundary)
   - 90% → `danger` (red)
   - 100% → `danger`

**Expected**: all boundary transitions match the unit test cases in
`ContextBadge.test.ts`.

---

### T3.2 — Fractional percentage rounds correctly

**Priority**: P1

**Steps**:
1. Force a percentage of 49.6% (via a conversation at ~50% context)
2. Inspect the badge

**Expected**:
- Displayed text: "50%" (rounded, not "49.6%" or "49%")
- State class: `warm` (after rounding)

---

### T3.3 — Clamping out-of-range values

**Priority**: P1

**Steps**:
1. Force a percentage of 150% (if possible — otherwise simulate via
   devtools console by calling `badge.setPercentage(150)`)
2. Force a negative value (`badge.setPercentage(-10)`)

**Expected**:
- 150% → clamped to 100, state = `danger`
- -10% → clamped to 0, state = `safe`
- No JavaScript errors

---

## §4 — ThinkingLoader Lifecycle

### T4.1 — Word rotation every ~2s

**Priority**: P1

**Steps**:
1. Send a message that triggers the thinking loader
2. Watch the word rotation for 10 seconds

**Expected**:
- Word text changes approximately every 2 seconds
- Words pulled from `thinkingWords.ts` (brainstorming, analyzing, etc.)
- No console warnings about cleared intervals

---

### T4.2 — Icon fallback on missing icon

**Priority**: P1

**Why**: Lucide icon names change between versions; plan requires
try/catch fallback to `sparkles` + bumped manifest.minAppVersion.

**Steps**:
1. Force Obsidian to skip the primary icon (temporarily rename
   `brain` → `nonexistent` in source if testing on a pre-1.5.0 host)
2. Trigger thinking loader

**Expected**:
- Primary icon call throws silently
- Fallback call to `sparkles` succeeds
- No visible error; loader shows sparkles icon instead

**Unit coverage**: `ThinkingLoader.test.ts` covers this via
`jest.spyOn(setIcon).mockImplementation(...)` — manual test confirms
the DOM renders the fallback icon correctly.

---

### T4.3 — Double-stop is safe

**Priority**: P1

**Steps**:
1. Trigger thinking loader
2. Click stop twice rapidly (or trigger cancel twice)

**Expected**:
- No errors in console
- Loader disappears
- Second stop is a no-op

---

## §5 — ToolInspectionModal Pagination

### T5.1 — Initial load shows most recent 50 messages

**Priority**: P0

**Steps**:
1. Open a conversation with ≥100 tool call messages
2. Click the inspect icon (eye) in the status bar
3. Modal opens

**Expected**:
- First page loads without cursor (`{pageSize: 50}`)
- 50 messages shown
- Scroll position is at the **bottom** (most recent)
- Loading indicator clears after fetch

**Unit coverage**: `ToolInspectionModal.test.ts` asserts
`getToolCallMessagesForConversation('convId', {pageSize: 50})` — manual
test confirms the DOM list renders with the most recent at bottom.

---

### T5.2 — Infinite scroll up loads previous page with cursor

**Priority**: P0

**Steps**:
1. In the open inspection modal, scroll to the **top** of the list
2. Watch the network/console for the next fetch

**Expected**:
- Second call: `getToolCallMessagesForConversation('convId', {cursor: '...', pageSize: 50})`
- Additional 50 messages load ABOVE the existing ones
- Scroll position stays anchored to the previously-top message (no jump)
- Loading indicator appears during fetch, clears when done

---

### T5.3 — `hasMorePages = false` stops further loads

**Priority**: P0

**Steps**:
1. Scroll to the very top of a conversation with <50 tool calls
2. Continue scrolling up

**Expected**:
- No additional fetches fire (confirmed via devtools Network tab)
- "End of conversation" hint or simply nothing loads above the first message

---

### T5.4 — Modal close mid-fetch does not mutate state

**Priority**: P0

**Steps**:
1. Open the inspection modal on a conversation with many tool calls
2. Throttle network to "Slow 3G" in devtools
3. Click to scroll up (triggering loadPreviousPage)
4. Close the modal BEFORE the fetch completes

**Expected**:
- No JavaScript errors after the late response arrives
- No "setState on unmounted component" warnings
- Re-opening the modal shows fresh state, not stale data

**Unit coverage**: `ToolInspectionModal.test.ts` has two gated-promise
tests for initial load and loadPreviousPage isDisposed guards.

---

### T5.5 — De-duplication on overlapping pages

**Priority**: P1

**Steps**:
1. Open the inspection modal
2. Force two pages with overlapping IDs (typically via rapid scroll +
   new messages arriving simultaneously)

**Expected**:
- Each message ID appears exactly once in the modal
- Sort order is by `sequenceNumber` ascending
- No duplicate accordions

---

## §6 — iOS Mobile-Specific

### T6.1 — Status bar clears safe-area inset

**Priority**: P0

**Steps**:
1. Open chat view on iOS device (iPhone with notch or Dynamic Island)
2. Scroll to the bottom
3. Check status bar position relative to home indicator

**Expected**:
- Status bar respects `env(safe-area-inset-bottom)`
- Buttons are not obscured by the home indicator
- No content hidden behind the iOS keyboard when it appears

---

### T6.2 — Tap targets pass 44×44pt Apple HIG

**Priority**: P0

**Steps**:
1. Open chat view on iOS
2. Attempt to tap each meta button (inspect, task, agent, compact)
3. Measure hit areas via Xcode Inspector if available, OR attempt
   taps at the extreme edges of each button

**Expected**:
- All buttons respond reliably at their edges
- No mis-taps between adjacent buttons
- Minimum 44×44pt hit area (Apple HIG) — stricter than WCAG 24×24

---

### T6.3 — Glass material renders without filter fallback

**Priority**: P0

**Why**: The plan chose faux-glass specifically to avoid iOS Safari's
`backdrop-filter` hit-test bugs. This test confirms the decision paid off.

**Steps**:
1. Open chat view on iOS Safari/Obsidian Mobile
2. Tap each meta button

**Expected**:
- Glass renders identically to desktop (color-mix layers, no blur)
- All taps land correctly (no hit-test offset from stacking context bugs)
- No visible Z-order issues (buttons stay above status bar background)

---

## §7 — Android Mobile-Specific

### T7.1 — No paint stutter on status bar updates

**Priority**: P1

**Why**: Android WebView historically struggled with `backdrop-filter`
rendering; faux-glass should eliminate this concern entirely.

**Steps**:
1. Open chat view on Android Obsidian Mobile
2. Trigger rapid tool call updates (send "Read 5 notes in parallel")
3. Watch the status bar paint behavior

**Expected**:
- Smooth updates, no jank
- No frame-rate drop below ~30fps

---

### T7.2 — ContextBadge readable on small screens

**Priority**: P1

**Steps**:
1. Open chat view on Android phone at default zoom
2. Check the ContextBadge at various percentages

**Expected**:
- "XX%" text is legible (16px font, weight 600 per plan)
- Color state clearly distinguishable
- Badge does not collide with cost label or compact icon

---

## §8 — `prefers-reduced-motion`

### T8.1 — Shimmer animation stops when reduced motion is enabled

**Priority**: P0

**Why**: Plan extends existing `prefers-reduced-motion` block at
`styles.css:6095`. A mockup-audit finding (pact-memory `5fd7f809`)
flagged perpetual motion as an accessibility concern.

**Steps**:
1. System Settings → enable "Reduce Motion"
2. Open chat view
3. Trigger a tool call (status bar becomes visible)
4. Observe the status bar for 10 seconds

**Expected**:
- Shimmer animation (if present on active tool states) is **disabled**
- All other animations (hover, focus) are short/disabled or instant
- ThinkingLoader either skips the word fade entirely or uses hard cuts
- No looping/perpetual motion

---

### T8.2 — Motion re-enables after system toggle

**Priority**: P1

**Steps**:
1. With motion reduced (T8.1), note behavior
2. Disable "Reduce Motion" at system level
3. Return to Obsidian and trigger another tool call (no reload)

**Expected**:
- Animations resume without requiring Obsidian reload
- `@media (prefers-reduced-motion: reduce)` rules deactivate correctly

---

## §9 — Subagent Isolation (PLAN CRITICAL)

### T9.1 — Subagent events do NOT reach parent status bar

**Priority**: P0

**Why**: `ToolStatusBarController` filters events by `messageId` —
only events matching the current streaming message reach the bar. This
prevents subagent tool events from leaking into the parent chat's UI.

**Steps**:
1. Start a conversation
2. Dispatch a subagent (via `/@`) that performs tool calls
3. Watch the parent conversation's status bar

**Expected**:
- Parent status bar does **NOT** update with subagent tool events
- Subagent's own tool status (if displayed elsewhere) updates independently
- Parent bar shows only tools for the currently-streaming parent message

**Unit coverage**: `ToolStatusBarController.test.ts` includes three
tests for the subagent filter — this manual test confirms the DOM
respects the filter in practice.

---

### T9.2 — Returning to parent conversation shows correct state

**Priority**: P0

**Steps**:
1. Have an active subagent branch (from T9.1)
2. Switch back to the parent conversation view
3. Switch to the subagent branch
4. Switch back again

**Expected**:
- Each switch shows the correct per-conversation status
- No stale subagent events in the parent bar
- No stale parent events in the subagent bar
- ContextBadge percentage is keyed by conversation ID (matches plan note)

---

## §10 — Theme Cross-Compat

### T10.1 — Default theme (light + dark)

**Priority**: P1

**Steps**:
1. Appearance → Default theme (light)
2. Open chat, screenshot status bar
3. Appearance → Default theme (dark)
4. Screenshot again

**Expected**: readable, visually distinct, glass material visible in both.

---

### T10.2 — Minimal theme

**Priority**: P1

**Steps**:
1. Install Minimal community theme
2. Test in both light and dark

**Expected**: no collisions with Minimal's own chrome; CSS variables
resolve correctly via `color-mix(in srgb, var(--background-primary), ...)`.

---

### T10.3 — High-contrast third-party theme

**Priority**: P1

**Steps**:
1. Install any high-contrast theme from Community Themes
2. Inspect glass material

**Expected**: glass renders with sufficient contrast; buttons are
accessible; no invisible text.

---

## §11 — Task-Board Icon Wiring

### T11.1 — Task-board icon opens TaskManager workspace view

**Priority**: P1

**Why**: Plan resolution 2026-04-10 — task-board icon opens existing
`TaskManager.openTasks` workspace view directly, not a new modal.

**Steps**:
1. Open chat view (conversation with active workspace)
2. Click the `.tool-status-task-icon` button

**Expected**:
- Obsidian opens the TaskManager task board view for the current workspace
- No new modal is spawned
- View shows the same task list as invoking TaskManager from command palette

**Fail if**: a new modal or custom component opens instead of the
existing TaskManager view.

---

### T11.2 — Task-board icon disabled/hidden when no workspace

**Priority**: P2

**Steps**:
1. Open chat view with no active workspace (new conversation, no project)
2. Observe task icon

**Expected**: icon is hidden or disabled (graceful no-op on click).

---

## Post-Test Checklist

After completing all P0 tests on desktop + at least one mobile device:

- [ ] All §1–§5 tests pass on desktop
- [ ] §6 iOS tests pass on at least one iPhone
- [ ] §8 reduced-motion tests pass on desktop
- [ ] §9 subagent isolation tests pass
- [ ] No `backdrop-filter` in any final CSS output (grep `styles.css`)
- [ ] Screenshots captured for §1, §2, §3 (before/after theme switch)
- [ ] Any failures filed as GitHub issues linked to PR #131

---

## Known Limitations

The following behaviors are intentional and do not constitute bugs:

1. **Leading-edge debounce**: rapid tool calls show only the first update
   immediately; subsequent calls are suppressed for 400ms — this is by design
2. **No word-level timestamps**: ThinkingLoader rotation uses fixed 2s intervals
3. **Inspection modal is conversation-wide**: pages from JSONL, not filtered
   by message — selecting a specific message to inspect is a future phase
4. **ContextBadge rounds fractional percentages**: 49.6% displays as "50%"
5. **No `backdrop-filter` anywhere**: intentional — see plan §3 glass rationale

---

## References

- Plan: `docs/plans/mobile-chat-glass-migration-plan.md`
- Mockup: `docs/mockups/mobile-chat-sidebar-redesign.{html,css,js}` (glass variant)
- Unit tests: `tests/unit/{ToolStatusBar,ContextBadge,ThinkingLoader,ToolInspectionModal,ToolStatusBarController,ToolEventCoordinator}.test.ts`
- Prior mockup audit findings: pact-memory `5fd7f809`
