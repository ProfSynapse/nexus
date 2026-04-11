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
  constructor(private controller: ToolStatusBarController) {}

  /**
   * Handle tool calls detected event
   */
  handleToolCallsDetected(messageId: string, toolCalls: ToolCallLike[]): void {
    if (toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {

        const metadata = getToolNameMetadata(
          toolCall.function?.name || toolCall.name
        );

        let parameters: unknown = toolCall.parameters || toolCall.arguments;
        if (!parameters && toolCall.function?.arguments) {
          parameters = toolCall.function.arguments;
        }
        if (typeof parameters === 'string') {
          try {
            parameters = JSON.parse(parameters);
          } catch {
            // leave as string if parsing fails
          }
        }

        // Extract the tool call data in the format expected by the status bar controller.
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
          // Pass through reasoning-specific properties
          type: toolCall.type,
          result: toolCall.result,
          status: toolCall.status,
          isVirtual: toolCall.isVirtual,
          success: toolCall.success
        };

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
  }

  /**
   * Handle tool execution started event
   */
  handleToolExecutionStarted(messageId: string, toolCall: { id: string; name: string; parameters?: unknown }): void {
    this.controller.handleToolEvent(messageId, 'started', toolCall);
  }

  /**
   * Handle tool execution completed event
   */
  handleToolExecutionCompleted(messageId: string, toolId: string, result: unknown, success: boolean, error?: string): void {
    this.controller.handleToolEvent(messageId, 'completed', { toolId, result, success, error });
  }

  /**
   * Handle generic tool event with data enrichment
   */
  handleToolEvent(messageId: string, event: 'detected' | 'updated' | 'started' | 'completed', data: ToolEventData): void {
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
