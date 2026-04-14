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
 * Used by ChatView to coordinate tool events from MessageManager
 * to the status bar controller, following the Coordinator pattern.
 */

import { getToolNameMetadata } from '../../../utils/toolNameUtils';
import { ToolStatusBarController } from '../controllers/ToolStatusBarController';
import type { ToolStatusEventData } from '../controllers/ToolStatusBarController';
import { ToolEventParser } from '../utils/ToolEventParser';

type ToolEventPayload = NonNullable<Parameters<typeof ToolEventParser.getToolEventInfo>[0]>;
type ToolCallLike = NonNullable<ToolEventPayload['toolCall']>;
type ToolEventData = ToolEventPayload;

export class ToolEventCoordinator {
  /**
   * Caches tool metadata (technicalName, displayName, parameters, etc.) from
   * 'detected' and 'started' events so that 'completed' events — which arrive
   * without a tool name — can still produce meaningful status-bar labels.
   *
   * Entries are deleted on completion. As a safety net against leaks (e.g. a
   * tool that starts but never completes), call {@link clearToolNameCache}
   * when streaming ends.
   */
  private toolNameCache = new Map<string, ToolStatusEventData>();

  /**
   * Tracks the most advanced event stage reached per message. Once the generic
   * path has emitted 'started' or 'completed' events, handleToolCallsDetected
   * (which fires late from the streaming chunk parser) should not regress the
   * status bar back to 'detected'.
   */
  private messageEventStage = new Map<string, 'detected' | 'started' | 'completed'>();

  constructor(private controller: ToolStatusBarController) {}

  /**
   * Clear the tool name cache. Call when streaming ends or the coordinator
   * is no longer needed, to prevent unbounded growth from orphaned entries.
   */
  clearToolNameCache(): void {
    this.toolNameCache.clear();
    this.messageEventStage.clear();
  }

  /**
   * Handle tool calls detected event.
   *
   * In the two-tool architecture, the LLM only ever calls `useTools`.
   * The individual tool invocations (contentManager.read, etc.) are
   * buried inside useTools' `parameters.calls[]` array. This method
   * unwraps that array and emits a synthetic `detected` event for each
   * inner call so the status bar shows "Reading foo.md" instead of the
   * generic "Preparing actions".
   */
  handleToolCallsDetected(messageId: string, toolCalls: ToolCallLike[]): void {
    if (!toolCalls || toolCalls.length === 0) return;

    // If the generic event path has already emitted started/completed events
    // for this message, skip detection — the status bar has moved past this
    // stage and re-emitting detected events would regress it.
    const stage = this.messageEventStage.get(messageId);
    if (stage === 'started' || stage === 'completed') return;


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

      // Unwrap useTools: extract inner calls and emit each as its own event.
      const normalized = rawName?.replace(/_/g, '.');
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

          const innerToolData: ToolStatusEventData = {
            id: toolCall.id,
            name: innerMeta.displayName,
            displayName: innerMeta.displayName,
            technicalName: innerMeta.technicalName,
            agentName: innerMeta.agentName,
            actionName: innerMeta.actionName,
            rawName: innerTechnical,
            parameters: innerParams,
            isComplete: toolCall.isComplete,
          };

          if (toolCall.id) {

            this.toolNameCache.set(toolCall.id, innerToolData);
          }

          this.controller.handleToolEvent(messageId, 'detected', innerToolData);
        }

        // If no inner calls were extracted, fall through to the generic path
        // so the user at least sees "Preparing actions".
        if (innerCalls.length > 0) continue;
      }

      // Default path: emit the tool call as-is (getTools, or useTools with no parseable calls).
      const metadata = getToolNameMetadata(rawName);
      const toolData: ToolStatusEventData = {
        id: toolCall.id,
        name: metadata.displayName,
        displayName: metadata.displayName,
        technicalName: metadata.technicalName,
        agentName: metadata.agentName,
        actionName: metadata.actionName,
        rawName: toolCall.function?.name || toolCall.name,
        parameters: parameters,
        isComplete: toolCall.isComplete,
        type: toolCall.type,
        result: toolCall.result,
        status: toolCall.status,
        isVirtual: toolCall.isVirtual,
        success: toolCall.success
      };

      if (toolCall.id) this.toolNameCache.set(toolCall.id, toolData);

      this.controller.handleToolEvent(messageId, 'detected', toolData);

      if (
        toolCall.providerExecuted &&
        (
          toolCall.result !== undefined ||
          toolCall.success !== undefined ||
          toolCall.error !== undefined
        )
      ) {
        this.controller.handleToolEvent(messageId, 'completed', {
          toolId: toolCall.id ?? undefined,
          result: toolCall.result,
          success: toolCall.success !== false,
          error: toolCall.error
        });
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
    const enriched: ToolStatusEventData = {
      ...toolCall,
      technicalName: metadata.technicalName,
      displayName: metadata.displayName,
      agentName: metadata.agentName,
      actionName: metadata.actionName,
      rawName: toolCall.name,
    };

    if (toolCall.id) this.toolNameCache.set(toolCall.id, enriched);

    this.controller.handleToolEvent(messageId, 'started', enriched);
  }

  /**
   * Handle tool execution completed event.
   *
   * Merges cached metadata from earlier 'detected'/'started' events so the
   * status bar can produce past-tense labels ("Opened note") instead of
   * silently dropping the update due to missing technicalName.
   */
  handleToolExecutionCompleted(messageId: string, toolId: string, result: unknown, success: boolean, error?: string): void {
    const cached = this.toolNameCache.get(toolId);

    this.controller.handleToolEvent(messageId, 'completed', {
      ...cached,
      toolId,
      result,
      success,
      error,
    });
    this.toolNameCache.delete(toolId);
  }

  /**
   * Handle generic tool event with data enrichment
   */
  handleToolEvent(messageId: string, event: 'detected' | 'updated' | 'started' | 'completed', data: ToolEventData): void {
    // Filter out useTools/getTools wrapper events — the inner tool events
    // (unwrapped in handleToolCallsDetected or emitted directly by
    // DirectToolExecutor) provide the meaningful status labels.
    // Without this filter, useTools completion overwrites the inner tool's
    // past-tense label ("Ran Read" → "Prepared actions").
    const rawName = (data?.name as string) || (data?.technicalName as string) || '';
    const normalized = rawName.replace(/_/g, '.');
    if (normalized === 'useTools' || normalized === 'getTools' ||
        normalized.endsWith('.useTools') || normalized.endsWith('.getTools')) {
      return;
    }

    // Track the most advanced event stage for this message so
    // handleToolCallsDetected (which fires late) doesn't regress the status bar.
    if (event === 'started' || event === 'completed') {
      this.messageEventStage.set(messageId, event);
    }

    const enriched = this.enrichToolEventData(data);
    this.controller.handleToolEvent(messageId, event, enriched as ToolStatusEventData);
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
