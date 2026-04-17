# Tool Status Bar State Machine — Architecture Plan

**Date**: 2026-04-14
**Status**: Draft
**Scope**: Replace race-prone dual-event-path tool status updates with a single-source-of-truth state machine

---

## 1. Problem Statement

Two independent event sources race to update the tool status bar:

1. **Streaming chunk parser** (detection path): As the LLM streams tokens, `StreamingResponseService` calls `ToolCallService.handleToolCallDetection()`, which fires `detected`/`updated` events via the registered `toolEventCallback`.

2. **DirectToolExecutor** (execution path): When tools actually execute, `ToolBatchExecutionService` fires `onStepStarted`/`onStepCompleted` observer callbacks, which are bridged back to `ToolCallService.fireToolEvent()` via `StreamingResponseService`'s `onToolEvent` option.

Both paths converge on `ToolCallService.fireToolEvent()`, which invokes the single `toolEventCallback` registered by `ChatView`. The callback routes to `ToolEventCoordinator`, which forwards to `ToolStatusBarController`, which pushes text to `ToolStatusBar`.

**The race**: The streaming parser often fires `detected` events AFTER `DirectToolExecutor` has already fired `started` or `completed` events for the same tool, because chunk parsing is asynchronous and buffered. This regresses the status bar from "Ran Read" back to "Running Read".

**Current band-aid**: `ToolEventCoordinator.messageEventStage` tracks the most advanced stage per *message* and suppresses late detection events. This is coarse-grained (per-message, not per-tool-call) and fragile (doesn't handle interleaved batch tool calls where one tool is completed while another is still detected).

---

## 2. Current Event Flow Map

### Event Source 1: Streaming Chunk Parser (Detection Path)

```
LLMService.generateResponseStream()
  → yields chunks with toolCalls[]
    → StreamingResponseService.generateResponse() (line ~269)
      → ToolCallService.handleToolCallDetection(messageId, toolCalls, isComplete, conversationId)
        → For each tool call:
          - First time: fireToolEvent(messageId, 'detected', toolData)
          - Subsequent + complete: fireToolEvent(messageId, 'updated', toolData)
        → toolEventCallback (registered by ChatView at line 395)
          → ChatView.handleToolEvent()
            → ToolEventCoordinator.handleToolEvent()  [GENERIC PATH]
              → filters useTools/getTools wrapper events
              → tracks messageEventStage
              → enrichToolEventData()
              → ToolStatusBarController.handleToolEvent()
```

Additionally, `ChatView` registers `MessageManager` callbacks that also route detected events:

```
MessageStreamHandler.events.onToolCallsDetected(messageId, toolCalls)
  → ChatView (via MessageManagerEvents)
    → ToolEventCoordinator.handleToolCallsDetected()  [SPECIFIC PATH]
      → Unwraps useTools → inner calls
      → emits synthetic 'detected' per inner call
      → ToolStatusBarController.handleToolEvent(messageId, 'detected', ...)
```

### Event Source 2: DirectToolExecutor (Execution Path)

```
ToolContinuationService.executeToolsAndContinue() (line ~165)
  → MCPToolExecution.executeToolCalls(toolExecutor, ..., onToolEvent, context)
    → ToolExecutionUtils.executeToolCalls()
      → DirectToolExecutor.executeToolCalls(toolCalls, context, onToolEvent)
        → For each tool call:
          - onToolEvent('started', { id, name, parameters })
          - Execute tool
          - onToolEvent('completed', { id, name, result, success, error })

        → For useTools calls, delegates to handleUseTool() with observer:
          → ToolBatchExecutionService.execute()
            → observer.onStepStarted(event) → onToolEvent('started', ...)
            → observer.onStepCompleted(event) → onToolEvent('completed', ...)

  onToolEvent propagates back up:
    → StreamingResponseService (line ~210-211):
        llmOptions.onToolEvent = (event, data) =>
          toolCallService.fireToolEvent(messageId, event, data)
      → toolEventCallback (registered by ChatView)
        → ChatView.handleToolEvent()
          → ToolEventCoordinator.handleToolEvent()  [GENERIC PATH]
```

### Key Observation

Both paths merge at `ToolCallService.fireToolEvent()` → `toolEventCallback` → `ChatView.handleToolEvent()` → `ToolEventCoordinator.handleToolEvent()`. The coordinator is the natural place to insert a state machine, because it is the single funnel through which ALL events pass before reaching the status bar.

### Files and Their Roles

| File | Role | Events it fires/routes |
|------|------|----------------------|
| `src/services/chat/StreamingResponseService.ts` | Bridges DirectToolExecutor events to ToolCallService; drives chunk parser detection | `detected`, `updated` (via handleToolCallDetection); `started`, `completed` (via onToolEvent bridge) |
| `src/services/chat/ToolCallService.ts` | Central event callback hub; manages detected tool ID set | `detected`, `updated`, `started`, `completed` (via fireToolEvent) |
| `src/services/chat/DirectToolExecutor.ts` | Executes tools; fires raw started/completed events via callback | `started`, `completed` (via onToolEvent callback) |
| `src/agents/toolManager/services/ToolBatchExecutionService.ts` | Executes inner tool calls for useTools batches | `onStepStarted`, `onStepCompleted` (via observer pattern) |
| `src/ui/chat/ChatView.ts` | Wires callbacks from ToolCallService and MessageManager | Routes all events to ToolEventCoordinator |
| `src/ui/chat/services/MessageStreamHandler.ts` | Parses streaming chunks; fires onToolCallsDetected | `detected` (via events.onToolCallsDetected) |
| `src/ui/chat/coordinators/ToolEventCoordinator.ts` | Routes events to controller; has band-aid stage tracking | Enriches and forwards to ToolStatusBarController |
| `src/ui/chat/controllers/ToolStatusBarController.ts` | Maps events to tense; pushes text to status bar | Produces final display text |
| `src/ui/chat/components/ToolStatusBar.ts` | DOM rendering container | Receives pushStatus() calls |
| `src/ui/chat/components/toolStatusLine.ts` | Animated text slot with 400ms throttle | Receives update() calls |
| `src/ui/chat/utils/toolDisplayFormatter.ts` | Produces human-readable labels from tool metadata | Pure function, no events |

---

## 3. Proposed Design: ToolCallStateManager

### 3.1 State Machine Per Tool Call

Each tool call (identified by a unique ID) has a lifecycle state:

```
idle → detected → started → completed
                          → failed
```

State transitions are **forward-only**. A tool call in `started` state cannot regress to `detected`. A tool call in `completed` or `failed` state is terminal.

```typescript
// src/ui/chat/services/ToolCallStateManager.ts

export type ToolCallPhase = 'detected' | 'started' | 'completed' | 'failed';

const PHASE_ORDER: Record<ToolCallPhase, number> = {
  detected: 0,
  started: 1,
  completed: 2,
  failed: 2,  // same rank as completed — both terminal
};

export interface ToolCallState {
  /** Unique ID for this tool call (from LLM or DirectToolExecutor) */
  id: string;
  /** Current lifecycle phase */
  phase: ToolCallPhase;
  /** The parent useTools call ID, if this is an inner tool call */
  parentId?: string;
  /** Metadata captured at detection/start time */
  metadata: ToolCallMetadata;
  /** Result data (populated on completed/failed) */
  result?: unknown;
  error?: string;
  success?: boolean;
  /** Timestamp of last state change */
  lastUpdated: number;
}

export interface ToolCallMetadata {
  technicalName?: string;
  displayName?: string;
  agentName?: string;
  actionName?: string;
  rawName?: string;
  parameters?: unknown;
  batchId?: string;
  callIndex?: number;
  totalCalls?: number;
  strategy?: 'serial' | 'parallel';
}

export interface StateChangeEvent {
  toolCallId: string;
  previousPhase: ToolCallPhase | null;  // null on first detection
  newPhase: ToolCallPhase;
  state: ToolCallState;
  messageId: string;
}

export type StateChangeListener = (event: StateChangeEvent) => void;
```

### 3.2 ToolCallStateManager API

```typescript
export class ToolCallStateManager {
  /** Active tool call states, keyed by tool call ID */
  private states = new Map<string, ToolCallState>();

  /** Listeners for state changes */
  private listeners: StateChangeListener[] = [];

  /** Message ID → Set<tool call ID> for cleanup */
  private messageToolCalls = new Map<string, Set<string>>();

  /**
   * Attempt to advance a tool call's state. Returns true if the state
   * actually changed, false if the transition was suppressed (regression
   * or no-op).
   */
  transition(
    messageId: string,
    toolCallId: string,
    targetPhase: ToolCallPhase,
    metadata?: Partial<ToolCallMetadata>,
    result?: { result?: unknown; success?: boolean; error?: string }
  ): boolean {
    const existing = this.states.get(toolCallId);

    // Reject regressions
    if (existing && PHASE_ORDER[targetPhase] <= PHASE_ORDER[existing.phase]) {
      // Allow metadata enrichment on same-phase updates (e.g., detected→detected
      // with more parameter info), but don't re-emit state change
      if (metadata && targetPhase === existing.phase) {
        this.mergeMetadata(existing, metadata);
      }
      return false;
    }

    const previousPhase = existing?.phase ?? null;

    const state: ToolCallState = {
      id: toolCallId,
      phase: targetPhase,
      parentId: existing?.parentId ?? metadata?.batchId,
      metadata: this.buildMetadata(existing?.metadata, metadata),
      result: result?.result ?? existing?.result,
      error: result?.error ?? existing?.error,
      success: result?.success ?? existing?.success,
      lastUpdated: Date.now(),
    };

    this.states.set(toolCallId, state);

    // Track which tool calls belong to which message
    let messageSet = this.messageToolCalls.get(messageId);
    if (!messageSet) {
      messageSet = new Set();
      this.messageToolCalls.set(messageId, messageSet);
    }
    messageSet.add(toolCallId);

    // Notify listeners
    const event: StateChangeEvent = {
      toolCallId,
      previousPhase,
      newPhase: targetPhase,
      state,
      messageId,
    };
    for (const listener of this.listeners) {
      listener(event);
    }

    return true;
  }

  /** Get current state for a tool call */
  getState(toolCallId: string): ToolCallState | undefined {
    return this.states.get(toolCallId);
  }

  /** Get all active (non-terminal) tool calls for a message */
  getActiveToolCalls(messageId: string): ToolCallState[] {
    const ids = this.messageToolCalls.get(messageId);
    if (!ids) return [];
    return Array.from(ids)
      .map(id => this.states.get(id))
      .filter((s): s is ToolCallState =>
        s !== undefined && s.phase !== 'completed' && s.phase !== 'failed'
      );
  }

  /** Subscribe to state changes */
  onStateChange(listener: StateChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Clear all state for a message (call when streaming ends) */
  clearMessage(messageId: string): void {
    const ids = this.messageToolCalls.get(messageId);
    if (ids) {
      for (const id of ids) {
        this.states.delete(id);
      }
      this.messageToolCalls.delete(messageId);
    }
  }

  /** Clear all state (call on dispose) */
  clear(): void {
    this.states.clear();
    this.messageToolCalls.clear();
    this.listeners = [];
  }

  private mergeMetadata(state: ToolCallState, update: Partial<ToolCallMetadata>): void {
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined) {
        (state.metadata as Record<string, unknown>)[key] = value;
      }
    }
  }

  private buildMetadata(
    existing?: ToolCallMetadata,
    update?: Partial<ToolCallMetadata>
  ): ToolCallMetadata {
    return {
      ...existing,
      ...Object.fromEntries(
        Object.entries(update ?? {}).filter(([, v]) => v !== undefined)
      ),
    };
  }
}
```

### 3.3 Two-Tool Architecture Handling

The LLM only calls `useTools` (the wrapper). The interesting tools are the inner calls in `useTools.parameters.calls[]`. The state machine handles this by:

1. **Detection path** (`handleToolCallsDetected`): Already unwraps `useTools` parameters and extracts inner calls. Each inner call gets a synthetic `detected` event. These should call `stateManager.transition(messageId, innerCallStepId, 'detected', innerMetadata)`.

2. **Execution path** (`DirectToolExecutor.handleUseTool`): The `ToolBatchExecutionService` observer fires `onStepStarted`/`onStepCompleted` for each inner call with a unique `stepId`. These should call `stateManager.transition(messageId, stepId, 'started'/'completed', ...)`.

3. **ID correlation**: The detection path assigns IDs from the LLM's tool call object (`toolCall.id`), while the execution path assigns IDs from `ToolBatchExecutionService` (`event.stepId`). These may not match. The fix: use the execution path's `stepId` as the canonical ID. The detection path should emit events with the *parent* useTools ID (which it already does), and the coordinator should map inner detection events to the batch context rather than individual step IDs. Alternatively, the batch execution service should use the same IDs that the detection path uses. This is an implementation detail — either approach works.

   **Recommended approach**: Let the state manager accept both detection and execution events independently. Detection events use the parent useTools ID + inner tool technical name as a composite key. Execution events use their stepId. The state manager treats them as separate entries. The status bar already shows the most recent event, so duplicate detection events for the same conceptual tool call are harmless — they'll be suppressed by the forward-only rule once the execution path fires `started`.

   More precisely: during detection, the coordinator creates entries like `{parentId}_{agent}.{tool}` for each inner call. During execution, the `ToolBatchExecutionService` creates entries with its own `stepId`. The status bar only cares about the *latest* state change event, not about correlating detection-to-execution. The forward-only rule on the *composite key* prevents regression.

   **Simplest approach** (recommended): Use the useTools parent tool call ID as the key for detection events on the parent wrapper itself, and let the execution path's inner `stepId` events be their own entries. The useTools wrapper events are already filtered out by `ToolEventCoordinator.handleToolEvent()` (lines 228-234), so they never reach the status bar. Inner detection events from `handleToolCallsDetected` will fire `detected` with their own composite IDs. Inner execution events will fire `started`/`completed` with their `stepId`s. The status bar sees the latest event from either path and displays it.

### 3.4 Integration with ToolEventCoordinator

The `ToolCallStateManager` replaces the band-aid `messageEventStage` map and most of the `toolNameCache`. The coordinator becomes a thin adapter:

```typescript
// Modified ToolEventCoordinator

export class ToolEventCoordinator {
  private stateManager: ToolCallStateManager;

  constructor(
    private controller: ToolStatusBarController,
    stateManager: ToolCallStateManager
  ) {
    this.stateManager = stateManager;

    // Subscribe to state changes — this is the ONLY path to the status bar
    this.stateManager.onStateChange((event) => {
      this.emitToStatusBar(event);
    });
  }

  /** Route detection events from streaming chunk parser */
  handleToolCallsDetected(messageId: string, toolCalls: ToolCallLike[]): void {
    // Existing useTools unwrap logic stays here
    // But instead of calling controller.handleToolEvent directly,
    // call stateManager.transition(messageId, id, 'detected', metadata)
    // The state machine will emit the change event if appropriate
  }

  /** Route execution started events from DirectToolExecutor */
  handleToolExecutionStarted(messageId: string, toolCall: {...}): void {
    const metadata = getToolNameMetadata(toolCall.name);
    this.stateManager.transition(messageId, toolCall.id, 'started', {
      technicalName: metadata.technicalName,
      displayName: metadata.displayName,
      agentName: metadata.agentName,
      actionName: metadata.actionName,
      rawName: toolCall.name,
      parameters: toolCall.parameters,
    });
  }

  /** Route execution completed events */
  handleToolExecutionCompleted(messageId: string, toolId: string, result: unknown, success: boolean, error?: string): void {
    this.stateManager.transition(
      messageId,
      toolId,
      success ? 'completed' : 'failed',
      undefined,
      { result, success, error }
    );
  }

  /** Route generic tool events (from ToolCallService callback path) */
  handleToolEvent(messageId: string, event: 'detected' | 'updated' | 'started' | 'completed', data: ToolEventData): void {
    // Existing useTools/getTools filter stays
    // Map event type to phase
    const phase = event === 'updated' ? 'detected' : event;
    const toolId = extractToolId(data);
    const metadata = this.extractMetadata(data);
    const result = event === 'completed' ? extractResult(data) : undefined;

    this.stateManager.transition(messageId, toolId, phase as ToolCallPhase, metadata, result);
  }

  /** State change → status bar text */
  private emitToStatusBar(event: StateChangeEvent): void {
    const { state, messageId } = event;
    const step = this.buildStep(state);
    const tense = state.phase === 'completed' ? 'past'
                : state.phase === 'failed' ? 'failed'
                : 'present';
    const text = formatToolStepLabel(step, tense);
    if (text) {
      this.controller.pushStatus(messageId, { text, state: tense });
    }
  }

  clearToolNameCache(): void {
    // Delegate to state manager clear
    this.stateManager.clear();
  }
}
```

### 3.5 What Gets Removed

| Current mechanism | Replacement |
|---|---|
| `ToolEventCoordinator.messageEventStage` (Map\<string, stage\>) | `ToolCallStateManager.transition()` forward-only rule |
| `ToolEventCoordinator.toolNameCache` (Map\<string, data\>) | `ToolCallStateManager.states` (metadata preserved in state entries) |
| `ToolStatusBarController.handleToolEvent()` event-to-tense mapping | Moved into `ToolEventCoordinator.emitToStatusBar()` |

### 3.6 Event Flow After Migration

```
Event Source 1 (Detection):
  StreamingResponseService → ToolCallService.handleToolCallDetection()
    → fireToolEvent('detected'/'updated')
      → ChatView.handleToolEvent()
        → ToolEventCoordinator.handleToolEvent()
          → stateManager.transition(id, 'detected')
            → [suppressed if already started/completed]
            → OR emits StateChangeEvent
              → emitToStatusBar() → ToolStatusBar.pushStatus()

Event Source 2 (Execution):
  DirectToolExecutor → onToolEvent('started'/'completed')
    → StreamingResponseService → ToolCallService.fireToolEvent()
      → ChatView.handleToolEvent()
        → ToolEventCoordinator.handleToolEvent()
          → stateManager.transition(id, 'started'/'completed')
            → emits StateChangeEvent
              → emitToStatusBar() → ToolStatusBar.pushStatus()

Event Source 3 (MessageManager specific callbacks):
  MessageStreamHandler → events.onToolCallsDetected
    → ChatView → ToolEventCoordinator.handleToolCallsDetected()
      → Unwraps useTools inner calls
      → For each: stateManager.transition(id, 'detected')
        → [suppressed if already started/completed]
```

---

## 4. Migration Path

### Phase 1: Create ToolCallStateManager (new file)

**File**: `src/ui/chat/services/ToolCallStateManager.ts` (new, ~150 lines)

- Implement `ToolCallStateManager` class as specified in section 3.2
- Export types: `ToolCallPhase`, `ToolCallState`, `ToolCallMetadata`, `StateChangeEvent`, `StateChangeListener`
- Pure logic, no DOM dependencies, fully testable

### Phase 2: Wire into ToolEventCoordinator

**File**: `src/ui/chat/coordinators/ToolEventCoordinator.ts` (~314 lines → ~250 lines)

Changes:
- Constructor takes `ToolCallStateManager` as second parameter (after `controller`)
- Subscribe to `stateManager.onStateChange()` in constructor
- `handleToolCallsDetected()` (line 66): Replace direct `controller.handleToolEvent()` calls with `stateManager.transition()` calls. Keep the useTools unwrap logic.
- `handleToolExecutionStarted()` (line 184): Replace direct `controller.handleToolEvent()` with `stateManager.transition(messageId, toolCall.id, 'started', metadata)`
- `handleToolExecutionCompleted()` (line 208): Replace direct `controller.handleToolEvent()` with `stateManager.transition(messageId, toolId, success ? 'completed' : 'failed', cached, { result, success, error })`
- `handleToolEvent()` (line 224): Replace direct `controller.handleToolEvent()` with `stateManager.transition()`
- **Remove** `messageEventStage` map (line 43) — replaced by forward-only rule in state manager
- **Remove** `toolNameCache` map (line 35) — replaced by state entries in state manager
- `clearToolNameCache()` (line 51): Delegate to `stateManager.clear()`
- Add `emitToStatusBar()` private method that converts `StateChangeEvent` → status bar push

### Phase 3: Simplify ToolStatusBarController

**File**: `src/ui/chat/controllers/ToolStatusBarController.ts` (~125 lines → ~80 lines)

Changes:
- `handleToolEvent()` method is no longer called directly by the coordinator. Instead, the coordinator calls a simpler `pushStatus()` method.
- Keep the method for backward compatibility during migration, or replace with a simpler `pushStatus(messageId: string, entry: ToolStatusEntry)` that just does message filtering + `toolStatusBar.pushStatus()`.
- The event-to-tense mapping logic (lines 101-118) moves into `ToolEventCoordinator.emitToStatusBar()`.
- The `toStep()` helper function and utility functions at the top can be removed or simplified.

### Phase 4: Update ChatView wiring

**File**: `src/ui/chat/ChatView.ts`

Changes:
- Line ~646: Create `ToolCallStateManager` instance before `ToolEventCoordinator`
- Pass state manager to `ToolEventCoordinator` constructor
- No other ChatView changes needed — the callback wiring stays the same

### Order of Changes

```
1. Create ToolCallStateManager.ts              (new file, no dependencies)
2. Update ToolEventCoordinator constructor      (add stateManager param)
3. Update ChatView.ts                          (instantiate stateManager, pass to coordinator)
4. Migrate handleToolEvent()                   (coordinator → stateManager.transition)
5. Migrate handleToolCallsDetected()           (coordinator → stateManager.transition)
6. Migrate handleToolExecutionStarted()        (coordinator → stateManager.transition)
7. Migrate handleToolExecutionCompleted()       (coordinator → stateManager.transition)
8. Add emitToStatusBar() listener              (coordinator subscribes to state changes)
9. Remove messageEventStage                    (replaced by state machine)
10. Remove toolNameCache                        (replaced by state entries)
11. Simplify ToolStatusBarController            (remove event-to-tense mapping)
```

Steps 2-10 should be done atomically in the ToolEventCoordinator to avoid an inconsistent intermediate state.

---

## 5. Edge Cases and Risks

### 5.1 Tool that starts but never completes

**Risk**: Memory leak in the state map from orphaned entries.

**Mitigation**: `clearMessage(messageId)` is called when streaming ends. This is already triggered by the existing `clearToolNameCache()` call path. The state manager should also have a timeout mechanism (e.g., 60-second TTL on non-terminal entries) as a safety net, but this is a future enhancement — `clearMessage()` on stream end is sufficient.

### 5.2 Concurrent tool calls in a batch

**Scenario**: useTools with `strategy: 'parallel'` and 3 inner calls. All 3 fire `started` near-simultaneously, then `completed` near-simultaneously.

**Handling**: Each inner call has its own `stepId` and its own state entry. The status bar shows the most recent state change. With parallel execution, the user will see rapid transitions: "Running Read" → "Running Write" → "Running Search" → "Ran Read" → "Ran Write" → "Ran Search". The 400ms throttle in `ToolStatusLine` naturally debounces these into a smooth experience.

### 5.3 Detection event with no execution event

**Scenario**: LLM calls `getTools` (discovery). The streaming parser detects it, but there's no separate execution path — the tool is executed inline by the LLM adapter without going through DirectToolExecutor's callback path.

**Handling**: The `getTools` wrapper is already filtered out by `ToolEventCoordinator.handleToolEvent()` at line 228-234. The state machine will also contain this entry, but it won't propagate to the status bar because the filter runs before `transition()` is called.

### 5.4 ID mismatch between detection and execution

**Scenario**: Detection path uses the LLM's tool call ID (e.g., `call_abc123`). Execution path uses a different ID from `ToolBatchExecutionService` (e.g., `step_0_contentManager_read`).

**Handling**: These are treated as independent entries in the state machine. The detection path creates `call_abc123` with phase `detected`. The execution path creates `step_0_contentManager_read` with phase `started`. Both fire state change events. The status bar shows whichever fired most recently. Once the execution path fires `completed`, the status bar settles on the past-tense label. The stale `detected` entry is cleaned up when `clearMessage()` runs.

This is intentionally loose coupling. Tight ID correlation would require threading IDs through the batch execution service, which adds complexity for no user-visible benefit — the status bar only ever shows one line of text at a time.

### 5.5 Streaming interruption / abort

**Scenario**: User aborts generation mid-tool-execution.

**Handling**: The abort signal triggers `clearMessage()` (already wired via `clearToolNameCache()`). All state entries for the message are purged. No regression risk because there's no state to regress.

### 5.6 SubagentController tool events

**Scenario**: Subagent execution also fires `onToolCallsDetected` events (see `SubagentController.ts` line 442).

**Handling**: These route through the same `toolEventCoordinator.handleToolCallsDetected()` path, so they'll use the state machine automatically. No special handling needed.

### 5.7 Legacy MCP connector path

**Scenario**: `ToolCallService.executeToolCalls()` (line 268, marked `@deprecated`) fires `started`/`completed` events directly via `fireToolEvent()` with empty messageId `''`.

**Handling**: The empty messageId flows through to the state manager. The state manager tracks it under the `''` key. This path is deprecated and only used for legacy Claude Desktop MCP connections. It works correctly because the forward-only rule is per-tool-call-ID, not per-message.

---

## 6. Testing Strategy

### Unit Tests for ToolCallStateManager

1. **Forward-only transitions**: `detected → started → completed` succeeds; `started → detected` is rejected
2. **Terminal states**: `completed` and `failed` reject further transitions
3. **Same-phase metadata merge**: `detected → detected` with new metadata updates without re-emitting
4. **State change listener**: Listener fires on actual transitions, not on rejected transitions
5. **clearMessage()**: Removes all entries for a message, stops firing events for those entries
6. **Multiple messages**: State is isolated per tool call ID, not per message
7. **Concurrent transitions**: Two calls to `transition()` for the same ID with different phases — the first one wins (JS is single-threaded, but verify the ordering semantics)

### Integration Tests for ToolEventCoordinator

1. **Race simulation**: Fire `started` event, then fire `detected` event for same tool → status bar should NOT regress
2. **Normal flow**: `detected → started → completed` → status bar shows present → present → past tense
3. **Batch flow**: 3 inner tool calls, each going through full lifecycle → all 3 reach `completed`
4. **useTools filter**: Wrapper `useTools` events are filtered before reaching state manager

### Manual Testing in Obsidian

1. **Chat with tool calls**: Send a message that triggers tool use (e.g., "read the file X"). Verify status bar shows "Reading X" → "Ran Read" without regression.
2. **Batch tool calls**: Trigger a useTools batch with multiple inner calls. Verify status bar cycles through inner tool labels.
3. **Rapid tool calls**: Trigger many tool calls in sequence. Verify no flickering or regression.
4. **Abort mid-tool**: Abort generation while a tool is executing. Verify clean state reset.

---

## 7. Scope Estimate

| Item | Files | Lines (approx) |
|------|-------|-----------------|
| New `ToolCallStateManager.ts` | 1 | ~150 |
| Modified `ToolEventCoordinator.ts` | 1 | ~-60 (net reduction) |
| Modified `ToolStatusBarController.ts` | 1 | ~-40 (net reduction) |
| Modified `ChatView.ts` | 1 | ~+5 (instantiation) |
| Unit tests for `ToolCallStateManager` | 1 | ~200 |
| **Total** | 5 | ~255 net new |

**Risk level**: Low-Medium. The change is additive (new file) with targeted modifications to 3 existing files. The state machine is a pure logic layer with no DOM dependencies. The coordinator's public API doesn't change — only its internals. ChatView wiring changes are minimal (one new instantiation line).

**What does NOT change**:
- `ToolCallService.ts` — still fires events via callback, no changes needed
- `DirectToolExecutor.ts` — still fires events via onToolEvent callback, no changes needed
- `StreamingResponseService.ts` — still bridges events, no changes needed
- `ToolBatchExecutionService.ts` — still fires observer events, no changes needed
- `ToolStatusBar.ts` — still receives pushStatus(), no changes needed
- `toolStatusLine.ts` — still throttles at 400ms, no changes needed
- `toolDisplayFormatter.ts` — still produces labels, no changes needed
- `ToolEventParser.ts` — still normalizes event data, no changes needed
- `MessageStreamHandler.ts` — still fires onToolCallsDetected, no changes needed

The blast radius is contained to the coordinator layer. Event sources and rendering are untouched.
