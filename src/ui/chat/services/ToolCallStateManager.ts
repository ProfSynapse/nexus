/**
 * ToolCallStateManager — Single-source-of-truth state machine for tool call
 * lifecycle phases. Replaces the race-prone `messageEventStage` and
 * `toolNameCache` maps in ToolEventCoordinator with forward-only per-tool-call
 * state tracking.
 *
 * Each tool call (identified by a unique ID) transitions through:
 *   idle → detected → started → completed | failed
 *
 * Transitions are forward-only: a tool in `started` cannot regress to
 * `detected`. Terminal states (`completed`, `failed`) reject further
 * transitions. Same-phase updates merge metadata without re-emitting.
 */

export type ToolCallPhase = 'detected' | 'started' | 'completed' | 'failed';

const PHASE_ORDER: Record<ToolCallPhase, number> = {
  detected: 0,
  started: 1,
  completed: 2,
  failed: 2, // same rank as completed — both terminal
};

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

export interface ToolCallState {
  /** Unique ID for this tool call */
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

export interface StateChangeEvent {
  toolCallId: string;
  previousPhase: ToolCallPhase | null; // null on first detection
  newPhase: ToolCallPhase;
  state: ToolCallState;
  messageId: string;
}

export type StateChangeListener = (event: StateChangeEvent) => void;

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

    // Reject regressions and same-phase re-emissions
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
