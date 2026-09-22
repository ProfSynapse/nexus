/**
 * OpenAIResponsesInput - Convert chat-completions-shaped history into
 * Responses API input items.
 *
 * Used by both the OpenAI and Codex adapters. The Responses API takes a flat
 * `input` array where prior turns are `{ role, content }` message items,
 * assistant tool calls are `function_call` items and their results are
 * `function_call_output` items. Every `function_call` replayed here must have
 * its matching `function_call_output`, otherwise the API rejects the request
 * (Codex enforces this strictly; stateful OpenAI does when no
 * `previous_response_id` is set).
 */

import { getMessageText, type ConversationMessage } from '../../core/ConversationMessage';

export type ResponsesInputItem = Record<string, unknown>;

/**
 * Convert prior messages (and optionally a trailing user prompt) to Responses
 * API input items. System messages are skipped — they belong in `instructions`.
 */
export function toResponsesInputItems(
  messages: ConversationMessage[],
  userPrompt?: string
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'tool') {
      // A tool result without an id cannot be paired to its call; the API
      // would reject the whole request, so drop the orphan rather than fail.
      if (!msg.tool_call_id) continue;
      items.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: getMessageText(msg) || '{}'
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const text = getMessageText(msg);
      if (text) {
        items.push({ role: 'assistant', content: text });
      }
      for (const tc of msg.tool_calls) {
        const name = ('name' in tc && tc.name) ? tc.name : tc.function?.name || '';
        items.push({
          type: 'function_call',
          call_id: tc.id,
          name,
          arguments: tc.function?.arguments || '{}'
        });
      }
      continue;
    }

    const text = getMessageText(msg);
    if (!text) continue;
    items.push({ role: msg.role, content: text });
  }

  if (userPrompt) {
    items.push({ role: 'user', content: userPrompt });
  }

  return items;
}
