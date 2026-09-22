/**
 * ConversationMessage - the message shape that flows from
 * StreamingResponseService.buildLLMMessages through LLMService and
 * StreamingOrchestrator to ProviderMessageBuilder.
 *
 * It is the provider builder's output, carried unchanged. Anthropic messages
 * put tool_use/tool_result/thinking in a `content` block array, Google puts
 * functionCall/functionResponse in `parts`, and OpenAI-style providers use a
 * string `content` plus `tool_calls` / `tool_call_id`. Nothing between the
 * builder and the adapter may project this to `{ role, content: string }` —
 * that projection is exactly how tool history used to get lost on the way to
 * the network (see docs/plans/turn-by-turn-history-and-provider-costing-plan.md).
 */

import type { ToolCall as AdapterToolCall } from '../adapters/types';
import type { ToolCall as ChatToolCall } from '../../../types/chat/ChatTypes';
import type { LLMContentBlock, GooglePart } from '../../chat/builders/IContextBuilder';

// Union type for tool calls from different sources
export type ToolCallUnion = AdapterToolCall | ChatToolCall;

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  /**
   * String for OpenAI-style providers; an Anthropic content-block array when the
   * turn carries tool_use / tool_result / thinking blocks. Google messages leave
   * this empty and use `parts`.
   */
  content: string | LLMContentBlock[];
  /** Google Gemini turn parts (text / functionCall / functionResponse). */
  parts?: GooglePart[];
  tool_calls?: ToolCallUnion[];
  /** Required on `role: 'tool'` messages — must match an assistant's tool_calls[i].id */
  tool_call_id?: string;
  /**
   * OpenRouter reasoning detail entries (opaque provider payload).
   * Must be preserved on tool-continuation turns for Gemini-via-OpenRouter
   * or the model loses its chain-of-thought between turns.
   */
  reasoning_details?: unknown[];
  /**
   * Google Gemini thought signature. Must be echoed back on continuation
   * requests after a tool call; dropping it degrades reasoning silently.
   */
  thought_signature?: string;
  /**
   * Legacy OpenAI `function` role name field. Some older stored conversations
   * and some OpenAI-compatible providers still attach this to tool/function
   * messages; stripping it can break strict schema validation.
   */
  name?: string;
}

/**
 * The prose of a message regardless of provider shape: the string content,
 * the joined `text` blocks, or the joined `parts[].text`. Used where a plain
 * string is genuinely required (the current user prompt, the CLI transports'
 * text transcript) — never as a substitute for the structured message.
 */
export function getMessageText(msg: Pick<ConversationMessage, 'content' | 'parts'>): string {
  if (typeof msg.content === 'string' && msg.content) {
    return msg.content;
  }

  if (Array.isArray(msg.content)) {
    return msg.content
      .map(block => block.type === 'text' ? block.text || '' : '')
      .filter(Boolean)
      .join('\n');
  }

  if (Array.isArray(msg.parts)) {
    return msg.parts
      .map(part => ('text' in part ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }

  return '';
}
