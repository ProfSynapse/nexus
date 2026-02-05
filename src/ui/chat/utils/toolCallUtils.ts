/**
 * Location: /src/ui/chat/utils/toolCallUtils.ts
 *
 * Purpose: Utility functions for tool call filtering and inspection
 * Used by: AbortHandler, MessageAlternativeService
 */

import { ToolCall } from '../../../types/chat/ChatTypes';

/**
 * Filter tool calls to keep only those that have completed execution.
 * A tool call is considered complete if it has a result or a success flag set.
 *
 * Returns undefined if no completed tool calls remain (or input is empty/undefined).
 */
export function filterCompletedToolCalls(toolCalls?: ToolCall[]): ToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) {
    return undefined;
  }

  const completed = toolCalls.filter(tc => tc.result !== undefined || tc.success !== undefined);

  return completed.length > 0 ? completed : undefined;
}
