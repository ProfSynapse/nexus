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

type ToolEventKind = 'detected' | 'updated' | 'started' | 'completed';

type ToolDisplayInput = Parameters<typeof normalizeToolCallForDisplay>[0];

type ToolCallFunctionLike = {
  name?: string;
  arguments?: string;
};

type ToolCallLike = {
  id?: string;
  stepId?: string;
  toolId?: string;
  parentToolCallId?: string;
  batchId?: string;
  callIndex?: number;
  totalCalls?: number;
  strategy?: string;
  parametersComplete?: boolean;
  name?: string;
  displayName?: string;
  technicalName?: string;
  type?: string;
  parameters?: unknown;
  result?: unknown;
  error?: unknown;
  success?: boolean;
  status?: string;
  isVirtual?: boolean;
  function?: ToolCallFunctionLike;
  arguments?: string;
};

type ToolEventDataLike = {
  [key: string]: unknown;
  toolCall?: unknown;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asToolEventData(value: unknown): ToolEventDataLike | undefined {
  return isRecord(value) ? value : undefined;
}

function asToolCall(value: unknown): ToolCallLike | undefined {
  return isRecord(value) ? (value as ToolCallLike) : undefined;
}

function getValue(source: unknown, key: string): unknown {
  if (!isRecord(source)) {
    return undefined;
  }

  return source[key];
}

function getStringValue(source: unknown, key: string): string | undefined {
  const value = getValue(source, key);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getNumberValue(source: unknown, key: string): number | undefined {
  const value = getValue(source, key);
  return typeof value === 'number' ? value : undefined;
}

function getBooleanValue(source: unknown, key: string): boolean | undefined {
  const value = getValue(source, key);
  return typeof value === 'boolean' ? value : undefined;
}

function getFirstString(...candidates: Array<string | null | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function buildToolCallLike(source: unknown): ToolCallLike | undefined {
  return asToolCall(source);
}

export class ToolEventParser {
  /**
   * Extract tool event information from raw event data
   */
  static getToolEventInfo(data: unknown, event?: ToolEventKind): ToolEventInfo {
    const eventData = asToolEventData(data);
    const toolCall = buildToolCallLike(eventData?.toolCall);
    const batchId = this.getBatchId(eventData, toolCall);
    const stepId = getFirstString(getStringValue(eventData, 'stepId'), getStringValue(eventData, 'id'), toolCall?.id) ?? null;
    const isBatchStepEvent = Boolean(
      batchId &&
      (
        typeof getNumberValue(eventData, 'callIndex') === 'number' ||
        typeof getNumberValue(eventData, 'totalCalls') === 'number' ||
        getValue(eventData, 'parentToolCallId') !== undefined ||
        getValue(eventData, 'batchId') !== undefined ||
        getValue(eventData, 'toolId') !== undefined
      )
    );
    const toolId = isBatchStepEvent
      ? batchId
      : getFirstString(
        getStringValue(eventData, 'toolId'),
        getStringValue(eventData, 'id'),
        toolCall?.id,
        batchId
      ) ?? null;
    const eventStatus = this.getEventStatus(eventData, event);
    const normalizedInput = toolCall ?? eventData;
    const displayInput: ToolDisplayInput = {
      id: toolId ?? getFirstString(getStringValue(normalizedInput, 'id'), getStringValue(normalizedInput, 'toolId'), getStringValue(eventData, 'id'), getStringValue(eventData, 'toolId')),
      stepId,
      toolId: getFirstString(batchId, getStringValue(eventData, 'toolId'), getStringValue(normalizedInput, 'toolId')),
      batchId: getFirstString(batchId, getStringValue(eventData, 'batchId')),
      parentToolCallId: getFirstString(
        getStringValue(eventData, 'parentToolCallId'),
        getStringValue(toolCall, 'parentToolCallId'),
        batchId
      ),
      callIndex: getNumberValue(eventData, 'callIndex') ?? getNumberValue(normalizedInput, 'callIndex'),
      totalCalls: getNumberValue(eventData, 'totalCalls') ?? getNumberValue(normalizedInput, 'totalCalls'),
      strategy: getStringValue(eventData, 'strategy') ?? getStringValue(normalizedInput, 'strategy'),
      name: getStringValue(eventData, 'name') ?? getStringValue(normalizedInput, 'name'),
      technicalName: getStringValue(eventData, 'technicalName') ?? getStringValue(normalizedInput, 'technicalName'),
      displayName: getStringValue(eventData, 'displayName') ?? getStringValue(normalizedInput, 'displayName'),
      type: getStringValue(eventData, 'type') ?? getStringValue(normalizedInput, 'type'),
      parameters: getValue(eventData, 'parameters') ?? getValue(normalizedInput, 'parameters'),
      result: getValue(eventData, 'result') ?? getValue(normalizedInput, 'result'),
      error: getStringValue(eventData, 'error') ?? getStringValue(normalizedInput, 'error'),
      success: getBooleanValue(eventData, 'success') ?? getBooleanValue(normalizedInput, 'success'),
      status: eventStatus,
      isVirtual: getBooleanValue(eventData, 'isVirtual') ?? getBooleanValue(normalizedInput, 'isVirtual'),
      function: toolCall?.function,
      arguments: toolCall?.arguments,
      parametersComplete: getBooleanValue(eventData, 'parametersComplete') ?? getBooleanValue(normalizedInput, 'parametersComplete')
    };
    const displayGroup = normalizeToolCallForDisplay(displayInput);

    const displayName = formatToolGroupHeader(displayGroup);
    const technicalName = displayGroup.technicalName;

    const parameters = this.extractToolParametersFromEvent(eventData);
    const isComplete =
      event === 'started'
        ? false
        : event === 'completed'
          ? true
          : getBooleanValue(eventData, 'isComplete') !== undefined
            ? Boolean(getBooleanValue(eventData, 'isComplete'))
            : Boolean(toolCall?.parametersComplete);

    // Extract reasoning-specific properties
    const type = getStringValue(eventData, 'type');
    const result = getValue(eventData, 'result');
    const status = eventStatus;
    const isVirtual = getBooleanValue(eventData, 'isVirtual');

    return {
      toolId,
      batchId,
      stepId,
      parentToolCallId: getFirstString(
        getStringValue(eventData, 'parentToolCallId'),
        getStringValue(toolCall, 'parentToolCallId'),
        batchId
      ) ?? null,
      callIndex: getNumberValue(eventData, 'callIndex'),
      totalCalls: getNumberValue(eventData, 'totalCalls'),
      strategy: getStringValue(eventData, 'strategy') ?? getStringValue(normalizedInput, 'strategy'),
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
  static extractToolParametersFromEvent(data: unknown): unknown {
    const eventData = asToolEventData(data);
    if (!eventData) {
      return undefined;
    }

    if (eventData.parameters !== undefined) {
      return this.parseParameterValue(eventData.parameters);
    }

    const toolCall = buildToolCallLike(eventData.toolCall);
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
  static getToolCallArguments(toolCall: unknown): unknown {
    const typedToolCall = buildToolCallLike(toolCall);
    if (!typedToolCall) {
      return undefined;
    }

    if (
      typedToolCall.function &&
      typeof typedToolCall.function === 'object' &&
      'arguments' in typedToolCall.function
    ) {
      return typedToolCall.function.arguments;
    }

    return typedToolCall.arguments;
  }

  private static getBatchId(data: unknown, toolCall: ToolCallLike | undefined): string | null {
    const candidates = [
      getStringValue(data, 'parentToolCallId'),
      getStringValue(data, 'batchId'),
      getStringValue(data, 'toolId'),
      toolCall?.parentToolCallId,
      toolCall?.batchId,
      toolCall?.toolId
    ];

    return getFirstString(...candidates) ?? null;
  }

  private static getEventStatus(data: unknown, event?: ToolEventKind): string | undefined {
    if (event === 'started') {
      return 'executing';
    }

    if (event === 'completed') {
      return getBooleanValue(data, 'success') === false ? 'failed' : 'completed';
    }

    const status = getStringValue(data, 'status');
    if (status !== undefined) {
      return status;
    }

    return undefined;
  }
}
