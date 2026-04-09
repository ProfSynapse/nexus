# Implementation Plan: Chat Status Bar + Context Badge

> Generated on 2026-04-09
> Status: PENDING APPROVAL

<!-- Status Lifecycle:
     PENDING APPROVAL -> APPROVED -> IN_PROGRESS -> IMPLEMENTED
                    \-> SUPERSEDED (if replaced by newer plan)
                    \-> BLOCKED (if unresolved conflicts)
-->

## Summary

Replace the full-width `ContextProgressBar` and inline `ProgressiveToolAccordion` with two new UI primitives:

1. **Tool Status Bar** — a persistent strip above the input showing the *currently executing tool* as bare shimmer text with slot-machine transitions between states
2. **Context Badge** — a compact percentage number that changes color as context fills up, sitting next to the status bar

Tool calls in the message stream become compact, clickable one-liners. Clicking opens a scrollable **Tool Inspection Modal** with full parameters and results.

### Design Inspiration

Drawn from [Claudian](https://github.com/YishenTu/claudian)'s approach of separating live execution state from the message stream, but with Nexus-specific animations and richer inspection.

---

## Visual Design

### Status Bar Layout (above input, below messages)

```
+---------------------------------------------------------+
|  messages...                                            |
|                                                         |
+---------------------------------------------------------+
|  Searching vault content...              72%            |  <-- status bar
|  ~~~~~~~~~~~~~~~~~~~~~~~~                ^^^            |
|  shimmer text (bare, no pill)      context badge        |
+---------------------------------------------------------+
|  [  Type your message...                    [>] ]       |  <-- input
+---------------------------------------------------------+
```

### Shimmer Animation (on active tool text)

```css
/* The text itself has a gradient overlay that sweeps left-to-right */

.tool-status-text-active {
    background: linear-gradient(
        90deg,
        var(--text-muted) 0%,
        var(--text-muted) 35%,
        var(--text-normal) 50%,        /* bright highlight band */
        var(--text-muted) 65%,
        var(--text-muted) 100%
    );
    background-size: 200% 100%;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    animation: shimmer-sweep 2s ease-in-out infinite;
}

@keyframes shimmer-sweep {
    0%   { background-position: 100% 0; }
    100% { background-position: -100% 0; }
}
```

The shimmer is subtle — the text color itself oscillates from muted to normal as the highlight band passes through. Not a skeleton loader; real text with a traveling brightness.

### Slot-Machine Transition (between tool states)

```
Frame 1 (tool A finishing):
  ┌──────────────────────────┐
  │ Searched vault content ✓ │  <- slides UP and fades out
  │ Storing results...       │  <- slides UP into position
  └──────────────────────────┘

Frame 2 (settled):
  ┌──────────────────────────┐
  │ Storing results...       │  <- shimmer starts
  └──────────────────────────┘
```

```css
/* Container clips overflow so outgoing text disappears above */
.tool-status-slot {
    overflow: hidden;
    height: 1.4em;
    position: relative;
}

/* Each text line is absolutely positioned, animated via class swap */
.tool-status-line {
    position: absolute;
    width: 100%;
    transition: transform 0.3s ease-out, opacity 0.3s ease-out;
}

.tool-status-line-entering {
    transform: translateY(100%);  /* start below */
    opacity: 0;
}

.tool-status-line-active {
    transform: translateY(0);     /* settled in view */
    opacity: 1;
}

.tool-status-line-exiting {
    transform: translateY(-100%); /* slide up and out */
    opacity: 0;
}
```

The transition fires when the tool status changes (e.g. `executing -> completed`, then next tool starts). The old text slides up and out; the new text slides up from below. Total duration ~300ms.

### Context Badge Color Progression

```
+------+------------------+----------------------------+
| Range| Color            | CSS Variable               |
+------+------------------+----------------------------+
| 0-50 | muted gray       | var(--text-faint)          |
| 50-75| yellow/amber     | var(--color-yellow)        |
| 75-90| orange           | var(--color-orange)        |
| 90+  | red (pulsing)    | var(--color-red)           |
+------+------------------+----------------------------+
```

```css
.context-badge {
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;   /* prevents width jitter */
    transition: color 0.5s ease;
    margin-left: auto;                    /* push to right edge */
    padding: 0 4px;
    white-space: nowrap;
}

.context-badge-safe    { color: var(--text-faint); }
.context-badge-warm    { color: var(--color-yellow); }
.context-badge-hot     { color: var(--color-orange); }
.context-badge-danger  { color: var(--color-red); animation: pulse-badge 1.5s ease-in-out infinite; }

@keyframes pulse-badge {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.6; }
}
```

Just a number like `72%`. No ring, no bar, no arc. The color does the talking.

### Tool Calls in Message Stream (compact one-liners)

Current accordion (before):
```
+----------------------------------------------------+
| [v] > Searched vault content                       |
|   Parameters:                                       |
|     { "query": "meeting notes", "limit": 10 }     |
|   Result:                                           |
|     Found 3 matching notes...                       |
+----------------------------------------------------+
```

Proposed compact line (after):
```
  [check] Searched vault content  ·  3 results  ·  1.2s    [inspect]
```

A single line with: status icon, human-readable label, brief result summary, execution time. Clicking anywhere on the line (or the inspect icon) opens the Tool Inspection Modal.

### Tool Inspection Modal

```
+----------------------------------------------------------+
|  Tool Execution Details                            [X]   |
|----------------------------------------------------------|
|                                                          |
|  Tool: Search Content                                    |
|  Agent: SearchManager                                    |
|  Status: Completed  (1.2s)                              |
|                                                          |
|  --- Parameters ---                                      |
|  {                                                       |
|    "query": "meeting notes",                            |
|    "limit": 10                                          |
|  }                                                [copy] |
|                                                          |
|  --- Result ---                                          |
|  {                                                       |
|    "success": true,                                     |
|    "results": [                                         |
|      { "title": "Weekly standup", ... },                |
|      { "title": "Retro notes", ... },                   |
|      ...                                                |
|    ]                                                    |
|  }                                                [copy] |
|                                                          |
+----------------------------------------------------------+
```

Scrollable content area. Copy buttons for params and result sections. Uses Obsidian's `Modal` base class.

---

## Architecture

### New Files

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/ui/chat/components/ToolStatusBar.ts` | Status bar: shimmer text + slot transitions + badge | ~200 |
| `src/ui/chat/components/ContextBadge.ts` | Percentage badge with color thresholds | ~80 |
| `src/ui/chat/components/ToolInspectionModal.ts` | Scrollable modal for tool detail inspection | ~150 |
| `src/ui/chat/components/CompactToolLine.ts` | Compact one-liner for tool calls in messages | ~120 |

### Modified Files

| File | Change | Impact |
|------|--------|--------|
| `src/ui/chat/builders/ChatLayoutBuilder.ts` | Add status bar container between messages and input | Low |
| `src/ui/chat/ChatView.ts` | Wire `ToolStatusBar` + `ContextBadge`, remove `ContextProgressBar` | Medium |
| `src/ui/chat/components/MessageBubble.ts` | Use `CompactToolLine` instead of `ProgressiveToolAccordion` for completed tools | Medium |
| `src/ui/chat/components/ProgressiveToolAccordion.ts` | Keep for *streaming* tools only, simplify (no expand/collapse needed) | Medium |
| `src/ui/chat/coordinators/ToolEventCoordinator.ts` | Feed events to `ToolStatusBar` in addition to message bubbles | Low |
| `src/ui/chat/services/ContextTracker.ts` | No change (already provides percentage) | None |
| `styles.css` | Add status bar, shimmer, slot, badge, compact tool line, modal styles | Medium |

### Removed/Deprecated

| Component | Action |
|-----------|--------|
| `ContextProgressBar` | Remove — replaced by `ContextBadge` |
| `context-progress-*` CSS (lines 3254-3333) | Remove — replaced by `context-badge-*` |

---

## Component Details

### ToolStatusBar

```
src/ui/chat/components/ToolStatusBar.ts
```

Responsibilities:
- Receives tool lifecycle events (start, complete, fail)
- Displays current tool name as bare text with shimmer animation
- Animates slot-machine transition between tool states
- Shows idle state when no tools are running (text fades out)
- Contains the `ContextBadge` as a right-aligned child

```
DOM structure:

.tool-status-bar                          (flex row, align-items center)
  .tool-status-slot                       (overflow hidden, fixed height)
    .tool-status-line[data-state]         (absolutely positioned text lines)
  .context-badge                          (right-aligned percentage)
```

State machine for each tool status line:

```
                    +-----------+
  new tool fires -> | entering  |  (translateY(100%), opacity 0)
                    +-----------+
                         |
                    0ms  v  300ms
                         |
                    +-----------+
                    |  active   |  (translateY(0), shimmer on)
                    +-----------+
                         |
          next tool  ->  |
                         v
                    +-----------+
                    |  exiting  |  (translateY(-100%), opacity 0)
                    +-----------+
                         |
                    300ms v
                         |
                    [removed from DOM]
```

**Text content per state:**
- `executing`:  `"Searching vault content..."` (present tense, shimmer ON)
- `completed`:  `"Searched vault content"` (past tense, shimmer OFF, brief flash)
- `failed`:     `"Search failed"` (shimmer OFF, text color red, brief flash)

After the completed/failed flash (~500ms), the next tool slides in.
If no more tools, the bar goes idle (text fades to empty, badge remains).

**Integration with existing tool event flow:**

```
ToolEventCoordinator
  |
  +---> MessageBubble (existing: updates tool accordion in message)
  |
  +---> ToolStatusBar (NEW: updates live status text)
            |
            +---> ContextBadge.update() (after each tool completes)
```

### ContextBadge

```
src/ui/chat/components/ContextBadge.ts
```

```typescript
// Simplified API — just a number and a color
export class ContextBadge {
  private element: HTMLElement;
  private currentClass: string = 'context-badge-safe';

  constructor(container: HTMLElement) { ... }

  update(percentage: number): void {
    this.element.textContent = `${Math.round(percentage)}%`;
    const cls = percentage >= 90 ? 'context-badge-danger'
              : percentage >= 75 ? 'context-badge-hot'
              : percentage >= 50 ? 'context-badge-warm'
              : 'context-badge-safe';
    if (cls !== this.currentClass) {
      this.element.removeClass(this.currentClass);
      this.element.addClass(cls);
      this.currentClass = cls;
    }
  }
}
```

No token counts, no bar, no label. Just `72%` that turns yellow, then orange, then pulsing red.

### CompactToolLine

```
src/ui/chat/components/CompactToolLine.ts
```

Renders a single-line tool call summary in the message stream:

```
[icon]  Searched vault content  ·  3 results  ·  1.2s
```

```typescript
export function renderCompactToolLine(
  step: ToolDisplayStep,
  container: HTMLElement,
  onInspect: (step: ToolDisplayStep) => void,
  component?: Component
): HTMLElement {
  const line = container.createDiv('compact-tool-line');
  line.setAttribute('data-tool-id', step.id);

  // Status icon
  const icon = line.createSpan('compact-tool-icon');
  const iconName = step.status === 'completed' ? 'check'
                 : step.status === 'failed' ? 'x'
                 : 'loader';
  setIcon(icon, iconName);

  // Human-readable label (past tense for completed)
  const label = line.createSpan('compact-tool-label');
  label.textContent = formatToolStepLabel(step, step.status === 'failed' ? 'failed' : 'past');

  // Brief result summary
  const summary = line.createSpan('compact-tool-summary');
  summary.textContent = summarizeResult(step);

  // Execution time
  if (step.executionTime) {
    const time = line.createSpan('compact-tool-time');
    time.textContent = formatDuration(step.executionTime);
  }

  // Click to inspect
  const handler = () => onInspect(step);
  if (component) {
    component.registerDomEvent(line, 'click', handler);
  } else {
    line.addEventListener('click', handler);
  }

  return line;
}
```

Note: this is a **function**, not a class — following the function-based rendering pattern from Claudian. No lifecycle, no state, no destroy. The `ToolDisplayStep` data object is the single source of truth; the function is a pure `(data) -> DOM` transform.

### ToolInspectionModal

```
src/ui/chat/components/ToolInspectionModal.ts
```

Extends Obsidian's `Modal`. Receives a `ToolDisplayStep` and renders full details.

```typescript
export class ToolInspectionModal extends Modal {
  constructor(app: App, private step: ToolDisplayStep) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('tool-inspection-modal');

    // Header: tool name + status + time
    // Parameters section: pre-formatted JSON with copy
    // Result section: pre-formatted JSON with copy, scrollable
    // Error section: if failed, red highlight
  }
}
```

---

## Migration Strategy

### Phase 1: Add new components alongside existing ones

1. Build `ContextBadge`, `ToolStatusBar`, `CompactToolLine`, `ToolInspectionModal`
2. Wire `ToolStatusBar` into `ChatLayoutBuilder` (new container div between messages and input)
3. Wire `ToolEventCoordinator` to feed events to `ToolStatusBar`
4. Add CSS for shimmer, slot transition, badge colors, compact lines, modal

At this point both old (accordion + progress bar) and new (status bar + badge) exist.

### Phase 2: Switch message stream to compact lines

1. In `MessageBubble`, render completed tools via `renderCompactToolLine()` instead of `ProgressiveToolAccordion`
2. `ProgressiveToolAccordion` stays for *actively streaming* tools only (live parameter updates during stream)
3. When streaming completes, replace the accordion with compact lines

### Phase 3: Remove old components

1. Remove `ContextProgressBar` class and its container from `ChatLayoutBuilder`
2. Remove `context-progress-*` CSS (~80 lines)
3. Slim down `ProgressiveToolAccordion` — no expand/collapse, no result rendering (modal handles that now)
4. Evaluate whether `ProgressiveToolAccordion` can be replaced entirely by updating `ToolStatusBar` text during streaming

---

## CSS Additions

All additions go in `styles.css` (single file per Obsidian policy).

```css
/* ========================= */
/* TOOL STATUS BAR           */
/* ========================= */

.tool-status-bar {
    display: flex;
    align-items: center;
    padding: 6px 12px;
    min-height: 28px;
    border-top: 1px solid var(--background-modifier-border);
    background: var(--background-primary);
    gap: 8px;
    font-size: 12px;
}

.tool-status-bar-hidden {
    display: none;
}

.tool-status-slot {
    overflow: hidden;
    height: 1.4em;
    position: relative;
    flex: 1;
}

.tool-status-line {
    position: absolute;
    width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: transform 0.3s ease-out, opacity 0.3s ease-out;
}

.tool-status-line-entering {
    transform: translateY(100%);
    opacity: 0;
}

.tool-status-line-active {
    transform: translateY(0);
    opacity: 1;
}

.tool-status-line-exiting {
    transform: translateY(-100%);
    opacity: 0;
}

/* Shimmer: traveling brightness on active tool text */
.tool-status-text-active {
    background: linear-gradient(
        90deg,
        var(--text-muted) 0%,
        var(--text-muted) 35%,
        var(--text-normal) 50%,
        var(--text-muted) 65%,
        var(--text-muted) 100%
    );
    background-size: 200% 100%;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    animation: shimmer-sweep 2s ease-in-out infinite;
}

@keyframes shimmer-sweep {
    0%   { background-position: 100% 0; }
    100% { background-position: -100% 0; }
}

.tool-status-text-done {
    color: var(--text-muted);
}

.tool-status-text-failed {
    color: var(--color-red);
}

/* ========================= */
/* CONTEXT BADGE             */
/* ========================= */

.context-badge {
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    transition: color 0.5s ease;
    margin-left: auto;
    padding: 0 4px;
    white-space: nowrap;
}

.context-badge-safe   { color: var(--text-faint); }
.context-badge-warm   { color: var(--color-yellow); }
.context-badge-hot    { color: var(--color-orange); }
.context-badge-danger { color: var(--color-red); animation: pulse-badge 1.5s ease-in-out infinite; }

@keyframes pulse-badge {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.6; }
}

/* ========================= */
/* COMPACT TOOL LINE         */
/* ========================= */

.compact-tool-line {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    margin: 2px 0;
    border-radius: 4px;
    font-size: 12px;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.15s ease;
}

.compact-tool-line:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
}

.compact-tool-icon {
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
}

.compact-tool-icon .tool-executing {
    animation: toolSpin 1s linear infinite;
}

.compact-tool-label {
    font-weight: 500;
}

.compact-tool-summary {
    color: var(--text-faint);
}

.compact-tool-summary::before {
    content: '\00B7';
    margin-right: 6px;
}

.compact-tool-time {
    color: var(--text-faint);
    font-size: 11px;
}

.compact-tool-time::before {
    content: '\00B7';
    margin-right: 6px;
}

/* ========================= */
/* TOOL INSPECTION MODAL     */
/* ========================= */

.tool-inspection-modal {
    max-width: 600px;
    max-height: 70vh;
}

.tool-inspection-modal .modal-content {
    overflow-y: auto;
    padding: 16px;
}

.tool-inspection-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--background-modifier-border);
}

.tool-inspection-section {
    margin-bottom: 16px;
}

.tool-inspection-section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
}

.tool-inspection-code {
    background: var(--background-secondary);
    border-radius: 4px;
    padding: 12px;
    font-family: var(--font-monospace);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 300px;
    overflow-y: auto;
}
```

---

## Interaction with Existing Plans

| Plan | Relationship |
|------|-------------|
| `human-readable-tool-accordions-plan.md` (IN_PROGRESS) | **Complementary** — that plan normalizes tool display names and tense. This plan consumes those normalized names in `ToolStatusBar` and `CompactToolLine`. The `toolDisplayFormatter.ts` and `toolDisplayNormalizer.ts` work stays relevant. |
| `model-agent-manager-refactor-plan.md` | **Independent** — no overlap. |
| `context-budgeting-and-cli-transport-plan.md` | **Adjacent** — context budgeting service may eventually feed more granular data to `ContextBadge`. Current `ContextTracker` percentage is sufficient for Phase 1. |

---

## Open Questions

1. **Idle state**: When no tools are running, should the status bar collapse entirely (save vertical space) or show the badge alone?
2. **Batch tool display**: When `useTools` fires 3 tools in parallel, should the status bar show all three (rotating?) or just "Running 3 tools..."?
3. **Cost badge**: The current `ContextProgressBar` also shows `$0.0042` cost. Should cost move into the badge (e.g. `72% · $0.04`) or stay in settings/header?
4. **Mobile**: Status bar works on mobile, but shimmer animation may not render with `-webkit-background-clip: text` on all mobile browsers. Need to test on iOS Obsidian. Fallback: plain animated opacity.
