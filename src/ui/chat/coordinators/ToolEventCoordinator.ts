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
 * to MessageBubble components, following the Coordinator pattern.
 */

import { getToolNameMetadata } from '../../../utils/toolNameUtils';
import { MessageDisplay } from '../components/MessageDisplay';

type ToolEventName = 'detected' | 'updated' | 'started' | 'completed';

interface ToolExecutionStartedPayload {
  id: string;
  name: string;
  parameters?: unknown;
}

interface ToolCallPayload {
  id?: unknown;
  name?: string;
  functionName?: string;
  parameters?: unknown;
  arguments?: unknown;
  functionArguments?: unknown;
  isComplete?: unknown;
  type?: unknown;
  result?: unknown;
  status?: unknown;
  isVirtual?: unknown;
  success?: unknown;
  providerExecuted?: unknown;
  error?: unknown;
}

export class ToolEventCoordinator {
  constructor(private messageDisplay: MessageDisplay) {}

  /**
   * Handle tool calls detected event
   */
  handleToolCallsDetected(messageId: string, toolCalls: unknown[]): void {
    const messageBubble = this.messageDisplay.findMessageBubble(messageId);

    if (messageBubble && toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const parsedToolCall = this.parseToolCall(toolCall);
        if (!parsedToolCall) {
          continue;
        }

        const rawName = this.firstTruthyString(
          parsedToolCall.functionName,
          parsedToolCall.name
        );

        const metadata = getToolNameMetadata(rawName);

        let parameters = parsedToolCall.parameters || parsedToolCall.arguments;
        if (!parameters && parsedToolCall.functionArguments !== undefined) {
          parameters = parsedToolCall.functionArguments;
        }
        parameters = this.parseJsonIfString(parameters);

        // Extract the tool call data in the format expected by MessageBubble
        const toolData = {
          id: parsedToolCall.id,
          name: metadata.displayName,
          displayName: metadata.displayName,
          technicalName: metadata.technicalName,
          agentName: metadata.agentName,
          actionName: metadata.actionName,
          rawName,
          parameters,
          isComplete: parsedToolCall.isComplete,
          // Pass through reasoning-specific properties
          type: parsedToolCall.type,
          result: parsedToolCall.result,
          status: parsedToolCall.status,
          isVirtual: parsedToolCall.isVirtual,
          success: parsedToolCall.success
        };

        messageBubble.handleToolEvent('detected', toolData);

        if (
          parsedToolCall.providerExecuted &&
          (
            parsedToolCall.result !== undefined ||
            parsedToolCall.success !== undefined ||
            parsedToolCall.error !== undefined
          )
        ) {
          messageBubble.handleToolEvent('completed', {
            toolId: parsedToolCall.id,
            result: parsedToolCall.result,
            success: parsedToolCall.success !== false,
            error: parsedToolCall.error
          });
        }
      }
    }
  }

  /**
   * Handle tool execution started event
   */
  handleToolExecutionStarted(messageId: string, toolCall: ToolExecutionStartedPayload): void {
    const messageBubble = this.messageDisplay.findMessageBubble(messageId);
    messageBubble?.handleToolEvent('started', toolCall);
  }

  /**
   * Handle tool execution completed event
   */
  handleToolExecutionCompleted(messageId: string, toolId: string, result: unknown, success: boolean, error?: string): void {
    const messageBubble = this.messageDisplay.findMessageBubble(messageId);
    messageBubble?.handleToolEvent('completed', { toolId, result, success, error });
  }

  /**
   * Handle generic tool event with data enrichment
   */
  handleToolEvent(messageId: string, event: ToolEventName, data: unknown): void {
    const messageBubble = this.messageDisplay.findMessageBubble(messageId);
    if (!messageBubble) {
      return;
    }

    const enriched = this.enrichToolEventData(data);
    messageBubble.handleToolEvent(event, enriched);
  }

  /**
   * Enrich tool event data with metadata
   */
  private enrichToolEventData(data: unknown): unknown {
    if (!data) {
      return data;
    }

    const dataRecord = this.asRecord(data);
    if (!dataRecord) {
      return data;
    }

    const toolCall = this.parseToolCall(dataRecord.toolCall);
    const rawName = this.firstTruthyString(
      this.getString(dataRecord, 'rawName'),
      this.getString(dataRecord, 'technicalName'),
      this.getString(dataRecord, 'name'),
      toolCall?.functionName,
      toolCall?.name
    );

    const metadata = getToolNameMetadata(rawName);
    const parameters =
      dataRecord.parameters !== undefined
        ? dataRecord.parameters
        : this.extractToolParameters(toolCall);

    return {
      ...dataRecord,
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
  private extractToolParameters(toolCall?: ToolCallPayload): unknown {
    if (!toolCall) {
      return undefined;
    }

    if (toolCall.parameters !== undefined) {
      return toolCall.parameters;
    }

    const raw =
      toolCall.functionArguments !== undefined
        ? toolCall.functionArguments
        : toolCall.arguments;

    if (raw === undefined) {
      return undefined;
    }

    return this.parseJsonIfString(raw);
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value === 'object' && value !== null) {
      return value as Record<string, unknown>;
    }

    return undefined;
  }

  private getString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
  }

  private parseToolCall(value: unknown): ToolCallPayload | undefined {
    const toolCallRecord = this.asRecord(value);
    if (!toolCallRecord) {
      return undefined;
    }

    const functionRecord = this.asRecord(toolCallRecord.function);

    return {
      id: toolCallRecord.id,
      name: this.getString(toolCallRecord, 'name'),
      functionName: functionRecord ? this.getString(functionRecord, 'name') : undefined,
      parameters: toolCallRecord.parameters,
      arguments: toolCallRecord.arguments,
      functionArguments: functionRecord?.arguments,
      isComplete: toolCallRecord.isComplete,
      type: toolCallRecord.type,
      result: toolCallRecord.result,
      status: toolCallRecord.status,
      isVirtual: toolCallRecord.isVirtual,
      success: toolCallRecord.success,
      providerExecuted: toolCallRecord.providerExecuted,
      error: toolCallRecord.error
    };
  }

  private parseJsonIfString(value: unknown): unknown {
    if (typeof value !== 'string') {
      return value;
    }

    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }

  private firstTruthyString(...values: Array<string | undefined>): string | undefined {
    for (const value of values) {
      if (value) {
        return value;
      }
    }

    return undefined;
  }
}
