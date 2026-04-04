/**
 * ToolEventParser - Parses and enriches tool event data
 * Location: /src/ui/chat/utils/ToolEventParser.ts
 *
 * This class is responsible for:
 * - Extracting tool information from event data
 * - Parsing tool parameters from various formats
 * - Normalizing tool names and metadata
 *
 * Used by MessageBubble to process tool events from the MessageManager,
 * ensuring consistent data structure for ProgressiveToolAccordion.
 */

import { normalizeToolCallForDisplay, ToolDisplayGroup } from './toolDisplayNormalizer';
import { formatToolGroupHeader } from './toolDisplayFormatter';

/**
 * Represents a tool call object that may have arguments in different locations
 * depending on the provider format (OpenAI-style vs direct arguments)
 */
interface ToolCallWithArguments {
  function?: {
    name?: string;
    arguments?: string;
  };
  arguments?: string;
  id?: string | null;
  toolId?: string | null;
  batchId?: string | null;
  parentToolCallId?: string | null;
  callIndex?: number;
  totalCalls?: number;
  strategy?: string;
  name?: string;
  technicalName?: string;
  displayName?: string;
  type?: string;
  parameters?: unknown;
  result?: unknown;
  error?: unknown;
  success?: boolean;
  isVirtual?: boolean;
  parametersComplete?: boolean;
  [key: string]: unknown;
}

interface ToolEventData extends ToolCallWithArguments {
  toolCall?: ToolCallWithArguments;
  stepId?: string | null;
  status?: string;
  isComplete?: boolean;
}

export interface ToolEventInfo {
  toolId: string | null;
  batchId?: string | null;
  stepId?: string | null;
  parentToolCallId?: string | null;
  callIndex?: number;
  totalCalls?: number;
  strategy?: string;
  isBatchStepEvent?: boolean;
  displayName: string;
  technicalName?: string;
  parameters?: unknown;
  isComplete: boolean;
  displayGroup: ToolDisplayGroup;
  // Reasoning-specific properties
  type?: string;
  result?: unknown;
  status?: string;
  isVirtual?: boolean;
}

export class ToolEventParser {
  private static toOptionalString(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * Extract tool event information from raw event data
   */
  static getToolEventInfo(data: ToolEventData | undefined, event?: 'detected' | 'updated' | 'started' | 'completed'): ToolEventInfo {
    const toolCall = data?.toolCall;
    const batchId = this.getBatchId(data, toolCall);
    const stepId = data?.stepId ?? data?.id ?? toolCall?.id ?? null;
    const isBatchStepEvent = Boolean(
      batchId &&
      (
        typeof data?.callIndex === 'number' ||
        typeof data?.totalCalls === 'number' ||
        data?.parentToolCallId !== undefined ||
        data?.batchId !== undefined ||
        data?.toolId !== undefined
      )
    );
    const toolId = isBatchStepEvent ? batchId : (data?.toolId ?? data?.id ?? toolCall?.id ?? batchId ?? null);
    const eventStatus = this.getEventStatus(data, event);
    const normalizedInput = toolCall || data;
    const normalizedToolId = this.toOptionalString(toolId);
    const normalizedStepId = this.toOptionalString(stepId);
    const normalizedBatchId = this.toOptionalString(batchId);
    const displayGroup = normalizeToolCallForDisplay({
      ...(normalizedInput ?? {}),
      id: normalizedToolId ?? this.toOptionalString(normalizedInput?.id) ?? this.toOptionalString(normalizedInput?.toolId) ?? this.toOptionalString(data?.id) ?? this.toOptionalString(data?.toolId),
      stepId: normalizedStepId,
      toolId: normalizedBatchId ?? this.toOptionalString(data?.toolId) ?? this.toOptionalString(normalizedInput?.toolId),
      batchId: normalizedBatchId ?? this.toOptionalString(data?.batchId),
      parentToolCallId: this.toOptionalString(data?.parentToolCallId) ?? this.toOptionalString(toolCall?.parentToolCallId) ?? normalizedBatchId,
      callIndex: data?.callIndex ?? normalizedInput?.callIndex,
      totalCalls: data?.totalCalls ?? normalizedInput?.totalCalls,
      strategy: data?.strategy ?? normalizedInput?.strategy,
      name: data?.name ?? normalizedInput?.name,
      technicalName: data?.technicalName ?? normalizedInput?.technicalName,
      displayName: data?.displayName ?? normalizedInput?.displayName,
      type: data?.type ?? normalizedInput?.type,
      parameters: data?.parameters ?? normalizedInput?.parameters,
      result: data?.result ?? normalizedInput?.result,
      error: this.toOptionalString((data?.error ?? normalizedInput?.error) as string | null | undefined),
      success: data?.success ?? normalizedInput?.success,
      status: eventStatus,
      isVirtual: data?.isVirtual ?? normalizedInput?.isVirtual,
      function: normalizedInput?.function,
      arguments: normalizedInput?.arguments,
      parametersComplete: data?.parametersComplete ?? normalizedInput?.parametersComplete
    });

    const displayName = formatToolGroupHeader(displayGroup);
    const technicalName = displayGroup.technicalName;

    const parameters = this.extractToolParametersFromEvent(data);
    const isComplete =
      event === 'started'
        ? false
        : event === 'completed'
          ? true
          : data?.isComplete !== undefined
            ? Boolean(data.isComplete)
            : Boolean(toolCall?.parametersComplete);

    // Extract reasoning-specific properties
    const type = data?.type;
    const result = data?.result;
    const status = eventStatus;
    const isVirtual = data?.isVirtual;

    return {
      toolId,
      batchId,
      stepId,
      parentToolCallId: this.toOptionalString(data?.parentToolCallId) ?? this.toOptionalString(toolCall?.parentToolCallId) ?? normalizedBatchId ?? null,
      callIndex: typeof data?.callIndex === 'number' ? data.callIndex : undefined,
      totalCalls: typeof data?.totalCalls === 'number' ? data.totalCalls : undefined,
      strategy: data?.strategy ?? normalizedInput?.strategy,
      isBatchStepEvent,
      displayName,
      technicalName,
      parameters,
      isComplete,
      // Include reasoning properties if present
      type,
      result,
      status,
      isVirtual,
      displayGroup
    };
  }

  /**
   * Extract tool parameters from event data
   */
  static extractToolParametersFromEvent(data: ToolEventData | undefined): unknown {
    if (!data) {
      return undefined;
    }

    if (data.parameters !== undefined) {
      return this.parseParameterValue(data.parameters);
    }

    const toolCall = data.toolCall;
    if (!toolCall) {
      return undefined;
    }

    if (toolCall.parameters !== undefined) {
      return this.parseParameterValue(toolCall.parameters);
    }

    const rawArguments = this.getToolCallArguments(toolCall);
    return this.parseParameterValue(rawArguments);
  }

  /**
   * Parse parameter value from string or object
   */
  static parseParameterValue(value: unknown): unknown {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }

    return value;
  }

  /**
   * Get tool call arguments from various formats
   */
  static getToolCallArguments(toolCall: ToolCallWithArguments | undefined): unknown {
    if (!toolCall) {
      return undefined;
    }

    const typedToolCall = toolCall;

    if (typedToolCall.function && typeof typedToolCall.function === 'object' && 'arguments' in typedToolCall.function) {
      return typedToolCall.function.arguments;
    }

    return typedToolCall.arguments;
  }

  private static getBatchId(data: ToolEventData | undefined, toolCall: ToolCallWithArguments | undefined): string | null {
    const candidates = [
      data?.parentToolCallId,
      data?.batchId,
      data?.toolId,
      toolCall?.parentToolCallId,
      toolCall?.batchId,
      toolCall?.toolId
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return null;
  }

  private static getEventStatus(data: ToolEventData | undefined, event?: 'detected' | 'updated' | 'started' | 'completed'): string | undefined {
    if (event === 'started') {
      return 'executing';
    }

    if (event === 'completed') {
      return data?.success === false ? 'failed' : 'completed';
    }

    if (data?.status !== undefined) {
      return data.status;
    }

    return undefined;
  }
}
