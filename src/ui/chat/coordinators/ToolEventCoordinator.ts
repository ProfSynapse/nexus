/**
 * ToolEventCoordinator - Coordinates tool execution events between services and UI
 * Location: /src/ui/chat/coordinators/ToolEventCoordinator.ts
 *
 * This class is responsible for:
 * - Handling tool call detection events
 * - Handling tool execution start events
 * - Handling tool execution completion events
 * - Enriching tool event data with metadata
 * - Extracting and normalizing tool parameters
 *
 * All event handler methods route through ToolCallStateManager.transition()
 * instead of calling the controller directly. The state manager enforces
 * forward-only phase transitions to prevent race-condition regressions.
 * State change events are converted to status bar text via emitToStatusBar().
 */

import { getToolNameMetadata } from '../../../utils/toolNameUtils';
import { ToolStatusBarController } from '../controllers/ToolStatusBarController';
import { ToolEventParser } from '../utils/ToolEventParser';
import { formatToolStepLabel } from '../utils/toolDisplayFormatter';
import type { ToolCallStateManager, ToolCallPhase, StateChangeEvent, ToolCallMetadata } from '../services/ToolCallStateManager';

type ToolEventPayload = NonNullable<Parameters<typeof ToolEventParser.getToolEventInfo>[0]>;
type ToolCallLike = NonNullable<ToolEventPayload['toolCall']>;
type ToolEventData = ToolEventPayload;

export class ToolEventCoordinator {
  private unsubscribe: (() => void) | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private controller: ToolStatusBarController,
    private stateManager: ToolCallStateManager
  ) {
    // Subscribe to state changes — this is the ONLY path to the status bar
    this.unsubscribe = this.stateManager.onStateChange((event) => {
      this.emitToStatusBar(event);
    });
  }

  /**
   * Clear the tool state and hide the status bar after a delay.
   * Call when streaming ends or the coordinator is no longer needed.
   */
  clearToolNameCache(): void {
    // Unsubscribe from state changes so late-arriving events
    // (from the detection path) don't cancel the hide timer.
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.stateManager.clear();
    // Hide the status bar after a short delay so the user can see the
    // final completed/failed status before it disappears.
    this.scheduleHide(2000);
  }

  /**
   * Re-subscribe to state changes if not currently listening.
   * Called when a new streaming turn begins after a previous clearToolNameCache.
   */
  ensureListening(): void {
    this.cancelHide();
    if (!this.unsubscribe) {
      this.unsubscribe = this.stateManager.onStateChange((event) => {
        this.emitToStatusBar(event);
      });
    }
  }

  /**
   * Schedule hiding the status bar. Cancels any pending hide timer.
   */
  private scheduleHide(delayMs: number): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.controller.getStatusBar().clearStatus();
    }, delayMs);
  }

  /**
   * Cancel any pending hide timer (e.g., when new tool events arrive).
   */
  private cancelHide(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  /**
   * Handle tool calls detected event.
   *
   * In the two-tool architecture, the LLM only ever calls `useTools`.
   * The individual tool invocations (contentManager.read, etc.) are
   * buried inside useTools' `parameters.calls[]` array. This method
   * unwraps that array and emits a synthetic `detected` transition for each
   * inner call so the status bar shows "Reading foo.md" instead of the
   * generic "Preparing actions".
   */
  handleToolCallsDetected(messageId: string, toolCalls: ToolCallLike[]): void {
    if (!toolCalls || toolCalls.length === 0) return;

    for (const toolCall of toolCalls) {
      const rawName = toolCall.function?.name || toolCall.name;

      // Parse parameters from whichever location they live in.
      let parameters: unknown = toolCall.parameters || toolCall.arguments;
      if (!parameters && toolCall.function?.arguments) {
        parameters = toolCall.function.arguments;
      }
      if (typeof parameters === 'string') {
        try { parameters = JSON.parse(parameters); } catch { /* leave as string */ }
      }

      // Filter useTools/getTools wrapper events — same filter as handleToolEvent()
      const normalized = rawName?.replace(/_/g, '.');
      const isGetTools = normalized === 'getTools' || (normalized?.endsWith('.getTools') ?? false);
      if (isGetTools) continue;

      // Unwrap useTools: extract inner calls and emit each as its own event.
      const isUseTools = normalized === 'useTools' || (normalized?.endsWith('.useTools') ?? false);


      if (isUseTools && parameters && typeof parameters === 'object') {
        const params = parameters as Record<string, unknown>;
        const innerCalls = Array.isArray(params.calls) ? params.calls : [];


        for (const inner of innerCalls) {
          if (!inner || typeof inner !== 'object') continue;
          const call = inner as Record<string, unknown>;
          const agent = typeof call.agent === 'string' ? call.agent : '';
          const tool = typeof call.tool === 'string' ? call.tool : '';
          if (!agent || !tool) continue;

          const innerTechnical = `${agent}.${tool}`;
          const innerMeta = getToolNameMetadata(innerTechnical);
          const innerParams = (typeof call.parameters === 'object' && call.parameters !== null)
            ? call.parameters as Record<string, unknown>
            : undefined;

          const toolCallId = toolCall.id || `detected_${innerTechnical}_${Date.now()}`;

          this.stateManager.transition(messageId, toolCallId, 'detected', {
            technicalName: innerMeta.technicalName,
            displayName: innerMeta.displayName,
            agentName: innerMeta.agentName,
            actionName: innerMeta.actionName,
            rawName: innerTechnical,
            parameters: innerParams,
          });
        }

        // If no inner calls were extracted, fall through to the generic path
        // so the user at least sees "Preparing actions".
        if (innerCalls.length > 0) continue;
      }

      // Default path: emit the tool call as-is (getTools, or useTools with no parseable calls).
      const metadata = getToolNameMetadata(rawName);
      const toolCallId = toolCall.id || `detected_${rawName}_${Date.now()}`;

      this.stateManager.transition(messageId, toolCallId, 'detected', {
        technicalName: metadata.technicalName,
        displayName: metadata.displayName,
        agentName: metadata.agentName,
        actionName: metadata.actionName,
        rawName: toolCall.function?.name || toolCall.name,
        parameters: parameters,
      });

      if (
        toolCall.providerExecuted &&
        (
          toolCall.result !== undefined ||
          toolCall.success !== undefined ||
          toolCall.error !== undefined
        )
      ) {
        this.stateManager.transition(
          messageId,
          toolCallId,
          toolCall.success !== false ? 'completed' : 'failed',
          undefined,
          {
            result: toolCall.result,
            success: toolCall.success !== false,
            error: typeof toolCall.error === 'string' ? toolCall.error : undefined,
          }
        );
      }
    }
  }

  /**
   * Handle tool execution started event.
   *
   * Enriches the raw tool call with metadata from getToolNameMetadata so the
   * status bar can produce specific labels ("Opening note") instead of generic
   * fallbacks ("Running Open").
   */
  handleToolExecutionStarted(messageId: string, toolCall: { id: string; name: string; parameters?: unknown }): void {
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

  /**
   * Handle tool execution completed event.
   *
   * The state machine preserves metadata from earlier phases, so the
   * status bar can produce past-tense labels even though completion
   * events arrive without a tool name.
   */
  handleToolExecutionCompleted(messageId: string, toolId: string, result: unknown, success: boolean, error?: string): void {
    this.stateManager.transition(
      messageId,
      toolId,
      success ? 'completed' : 'failed',
      undefined,
      { result, success, error }
    );
  }

  /**
   * Handle generic tool event with data enrichment.
   * Filters useTools/getTools wrapper events before transitioning.
   */
  handleToolEvent(messageId: string, event: 'detected' | 'updated' | 'started' | 'completed', data: ToolEventData): void {
    // Filter out useTools/getTools wrapper events — the inner tool events
    // (unwrapped in handleToolCallsDetected or emitted directly by
    // DirectToolExecutor) provide the meaningful status labels.
    // Without this filter, useTools completion overwrites the inner tool's
    // past-tense label ("Ran Read" -> "Prepared actions").
    const rawName = (data?.name as string) || (data?.technicalName as string) || '';
    const normalizedName = rawName.replace(/_/g, '.');
    if (normalizedName === 'useTools' || normalizedName === 'getTools' ||
        normalizedName.endsWith('.useTools') || normalizedName.endsWith('.getTools')) {
      return;
    }

    // Map event type to phase. Check for failure on completed events.
    let phase: ToolCallPhase = event === 'updated' ? 'detected' : event;
    if (event === 'completed' && (data?.success === false || (typeof data?.error === 'string' && data.error.length > 0))) {
      phase = 'failed';
    }

    // Extract tool ID
    const toolId = (data?.id as string) || (data?.toolId as string) || `generic_${rawName}_${Date.now()}`;

    // Enrich metadata
    const enriched = this.enrichToolEventData(data);
    const metadata: Partial<ToolCallMetadata> = {
      technicalName: typeof enriched.technicalName === 'string' ? enriched.technicalName : undefined,
      displayName: typeof enriched.displayName === 'string' ? enriched.displayName : undefined,
      agentName: typeof enriched.agentName === 'string' ? enriched.agentName : undefined,
      actionName: typeof enriched.actionName === 'string' ? enriched.actionName : undefined,
      rawName: typeof enriched.rawName === 'string' ? enriched.rawName : undefined,
      parameters: enriched.parameters,
    };

    const resultData = event === 'completed' ? {
      result: data?.result,
      success: data?.success !== false,
      error: typeof data?.error === 'string' ? data.error : undefined,
    } : undefined;

    this.stateManager.transition(messageId, toolId, phase, metadata, resultData);
  }

  /**
   * State change -> status bar text. Converts phase to tense, builds a
   * display step from state metadata, and pushes to the controller.
   */
  private emitToStatusBar(event: StateChangeEvent): void {
    // New tool activity cancels any pending auto-hide
    this.cancelHide();
    const { state, messageId } = event;

    const tense: 'present' | 'past' | 'failed' =
      state.phase === 'completed' ? 'past'
      : state.phase === 'failed' ? 'failed'
      : 'present';

    const step = {
      technicalName: state.metadata.technicalName || state.metadata.rawName,
      displayName: state.metadata.displayName,
      actionName: state.metadata.actionName,
      parameters: typeof state.metadata.parameters === 'object' && state.metadata.parameters !== null && !Array.isArray(state.metadata.parameters)
        ? state.metadata.parameters as Record<string, unknown>
        : undefined,
      result: state.result,
      error: state.error,
    };

    const text = formatToolStepLabel(step, tense);
    if (text) {
      this.controller.pushStatus(messageId, { text, state: tense });
    }
  }

  /**
   * Enrich tool event data with metadata
   */
  private enrichToolEventData(data: ToolEventData): ToolEventData {
    if (!data) {
      return data;
    }

    const toolCall = data.toolCall;
    const rawName = [
      data.rawName,
      data.technicalName,
      data.name,
      toolCall?.function?.name,
      toolCall?.name
    ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);

    const metadata = getToolNameMetadata(rawName || '');
    const parameters =
      data.parameters !== undefined
        ? data.parameters
        : this.extractToolParameters(toolCall);

    return {
      ...data,
      name: metadata.displayName,
      displayName: metadata.displayName,
      technicalName: metadata.technicalName,
      agentName: metadata.agentName,
      actionName: metadata.actionName,
      rawName,
      parameters
    };
  }

  /**
   * Extract tool parameters from tool call data
   */
  private extractToolParameters(toolCall: ToolCallLike | undefined): unknown {
    if (!toolCall) {
      return undefined;
    }

    if (toolCall.parameters !== undefined) {
      return toolCall.parameters;
    }

    const raw =
      toolCall.function?.arguments !== undefined
        ? toolCall.function.arguments
        : toolCall.arguments;

    if (raw === undefined) {
      return undefined;
    }

    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }

    return raw;
  }
}
