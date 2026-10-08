/**
 * OpenAIContextBuilder - Builds conversation context for OpenAI-compatible providers
 *
 * Used by: OpenAI, OpenRouter, Groq, Mistral, Requesty, Perplexity
 *
 * OpenAI format uses:
 * - Separate assistant + tool result messages
 * - tool_calls array in assistant messages
 * - 'tool' role for tool results with tool_call_id
 *
 * Follows Single Responsibility Principle - only handles OpenAI format.
 */

import { IContextBuilder, LLMMessage, LLMToolCall, ToolExecutionResult, OpenAIMessage } from './IContextBuilder';
import { ConversationData, ChatMessage, ToolCall } from '../../../types/chat/ChatTypes';
import { ReasoningPreserver } from '../../llm/adapters/shared/ReasoningPreserver';
import { synthesizeToolCallId } from '../../llm/utils/toolCallId';

type ReasoningToolCallLike = {
  id?: string;
  type?: string;
  name?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  parameters?: Record<string, unknown>;
  reasoning_details?: unknown[];
  thought_signature?: string;
};

type MistralResponseRecord = {
  content: OpenAIMessage['content'];
  toolCallIds: string[];
  contentEndOffset?: number;
};

export class OpenAIContextBuilder implements IContextBuilder {
  constructor(readonly provider: 'openai' | 'mistral' = 'openai') {}

  private assistantContent(
    toolCalls: Array<Pick<LLMToolCall, 'mistral_assistant_content'>> | undefined,
    metadata: Record<string, unknown> | undefined,
    fallback: string
  ): OpenAIMessage['content'] {
    if (this.provider !== 'mistral') return fallback;
    const preserved = toolCalls?.find(call => call.mistral_assistant_content?.length)
      ?.mistral_assistant_content ?? metadata?.mistralAssistantContent;
    return Array.isArray(preserved) && preserved.length > 0
      ? preserved as Array<Record<string, unknown>>
      : fallback;
  }

  private mistralResponseRecords(metadata: Record<string, unknown> | undefined): MistralResponseRecord[] | null {
    const rawRecords: unknown = metadata?.mistralResponses;
    if (this.provider !== 'mistral' || !Array.isArray(rawRecords)) return null;
    const records = rawRecords as unknown[];
    if (records.length === 0) return null;
    const valid = records.every(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const record = raw as Record<string, unknown>;
      return (typeof record.content === 'string' || Array.isArray(record.content))
        && Array.isArray(record.toolCallIds)
        && record.toolCallIds.every((id: unknown) => typeof id === 'string')
        && (record.contentEndOffset === undefined
          || (typeof record.contentEndOffset === 'number' && Number.isSafeInteger(record.contentEndOffset)));
    });
    return valid ? records as MistralResponseRecord[] : null;
  }

  /**
   * Validate if a message should be included in LLM context
   */
  private isValidForContext(msg: ChatMessage, isLastMessage: boolean): boolean {
    if (msg.state === 'invalid' || msg.state === 'streaming') return false;
    if (msg.role === 'user' && (!msg.content || !msg.content.trim())) return false;

    if (msg.role === 'assistant') {
      const hasContent = msg.content && msg.content.trim();
      const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;
      const hasMistralResponses = this.mistralResponseRecords(msg.metadata) !== null;

      if (!hasContent && !hasToolCalls && !hasMistralResponses && !isLastMessage) return false;

      if (hasToolCalls && msg.toolCalls) {
        const allHaveResults = msg.toolCalls.every((tc: ToolCall) =>
          tc.result !== undefined || tc.error !== undefined
        );
        if (!allHaveResults) return false;
      }
    }

    return true;
  }

  /**
   * Build context from stored conversation
   */
  buildContext(conversation: ConversationData, systemPrompt?: string): LLMMessage[] {
    const messages: OpenAIMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Filter valid messages
    const validMessages = conversation.messages.filter((msg, index) => {
      const isLastMessage = index === conversation.messages.length - 1;
      return this.isValidForContext(msg, isLastMessage);
    });

    validMessages.forEach((msg) => {
      if (msg.role === 'user') {
        if (msg.content && msg.content.trim()) {
          messages.push({ role: 'user', content: msg.content });
        }
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          // CRITICAL: Always normalize tool_call ids to OpenAI-compatible format
          // (`call_*` prefix). Conversations may have ids from other providers
          // (e.g., Bedrock's `toolu_bdrk_*`, Anthropic's `toolu_*`) which can
          // confuse Azure's Responses API converter when OpenRouter routes
          // OpenAI models through Azure, causing "Missing required parameter:
          // 'input[N].call_id'" errors.
          //
          // We use a deterministic id derived from message id + index so that
          // assistant tool_calls and the corresponding tool result messages
          // always reference the same id within this conversation.
          const msgIdSeed = (msg.id || `msg_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
          const normalizedIds = msg.toolCalls.map((tc: ToolCall, idx: number) => {
            // Keep the existing id only if it already looks like an OpenAI id
            // (starts with `call_`). Prefix-only check — OpenAI ids routinely
            // contain characters like `.` that a strict [A-Za-z0-9_-] regex
            // rejects, causing unnecessary renormalization.
            if (tc.id && /^call_/.test(tc.id)) {
              return tc.id;
            }
            return `call_${msgIdSeed}_${idx}`;
          });

          const toolCalls = msg.toolCalls;
          const appendToolRound = (group: number[], content: OpenAIMessage['content']): void => {
            // Rebuild through the same helper used during tool continuation so
            // reasoning_details and thought signatures survive other providers.
            const assistantMessage = ReasoningPreserver.buildAssistantMessageWithReasoning(
              group.map(index => {
                const tc = toolCalls[index];
                return {
                  id: normalizedIds[index],
                  type: 'function' as const,
                  function: {
                    name: tc.function?.name || tc.name || '',
                    arguments: tc.function?.arguments || JSON.stringify(tc.parameters || {})
                  },
                  reasoning_details: tc.reasoning_details,
                  thought_signature: tc.thought_signature
                };
              }),
              typeof content === 'string' ? content : ''
            ) as unknown as OpenAIMessage;
            assistantMessage.content = content;
            messages.push(assistantMessage);

            // Tool results must immediately follow the assistant response that
            // issued their ids, including when several calls share one round.
            for (const index of group) {
              const toolCall = toolCalls[index];
              messages.push({
                role: 'tool',
                tool_call_id: normalizedIds[index],
                content: toolCall.success !== false
                  ? JSON.stringify(toolCall.result || {})
                  : JSON.stringify({ error: toolCall.error || 'Tool execution failed' })
              });
            }
          };

          // Response records preserve actual boundaries, including identical
          // content in separate rounds and a plain-text final Requesty answer.
          const records = this.mistralResponseRecords(msg.metadata);
          const recordsCoverContent = records?.at(-1)?.contentEndOffset === (msg.content || '').length;
          const indexesById = new Map(toolCalls.map((call, index) => [call.id, index]));
          const used = new Set<number>();
          const completeRecords = recordsCoverContent && records && records.every(record => record.toolCallIds.every(id => {
            const index = indexesById.get(id);
            if (index === undefined || used.has(index)) return false;
            used.add(index);
            return true;
          })) && used.size === toolCalls.length;
          if (completeRecords && records) {
            for (const record of records) {
              const group = record.toolCallIds.map(id => indexesById.get(id)!);
              if (group.length > 0) appendToolRound(group, record.content);
              else messages.push({ role: 'assistant', content: record.content });
            }
          } else {
            // Legacy/incomplete captures cannot safely identify boundaries.
            // Preserve all visible answer text rather than picking the first
            // tool call's pre-tool snapshot and dropping later responses.
            appendToolRound(toolCalls.map((_, index) => index), msg.content || '');
          }
        } else {
          const records = this.mistralResponseRecords(msg.metadata);
          const recordsCoverContent = records?.at(-1)?.contentEndOffset === (msg.content || '').length;
          if (recordsCoverContent && records && records.every(record => record.toolCallIds.length === 0)) {
            for (const record of records) messages.push({ role: 'assistant', content: record.content });
          } else if (msg.content && msg.content.trim()) {
            messages.push({ role: 'assistant', content: records ? msg.content : this.assistantContent(undefined, msg.metadata, msg.content) });
          }
        }
      } else if (msg.role === 'tool') {
        // Handle separately stored tool result messages (from subagent)
        // These need tool_call_id from metadata
        const toolCallId = msg.metadata?.toolCallId as string | undefined;
        if (toolCallId) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: msg.content || '{}'
          });
        }
      }
    });

    return messages;
  }

  /**
   * Build tool continuation for pingpong pattern
   * IMPORTANT: Filters out system messages - they should be passed separately as systemPrompt
   */
  buildToolContinuation(
    userPrompt: string,
    toolCalls: LLMToolCall[],
    toolResults: ToolExecutionResult[],
    previousMessages?: LLMMessage[],
    _systemPrompt?: string
  ): LLMMessage[] {
    const messages: OpenAIMessage[] = [];

    // Filter out system messages - OpenAI/OpenRouter expect them in a separate systemPrompt param
    if (previousMessages && previousMessages.length > 0) {
      const nonSystemMessages = previousMessages.filter(msg => (msg as OpenAIMessage).role !== 'system');
      messages.push(...(nonSystemMessages as OpenAIMessage[]));
    }

    if (userPrompt) {
      messages.push({ role: 'user', content: userPrompt });
    }

    // Synthesize ids for any tool calls missing them. Both the assistant's
    // tool_calls and the tool result messages must reference the same id —
    // empty/mismatched ids cause Azure-via-OpenRouter to reject continuations.
    const synthesizedIds = toolCalls.map((tc) =>
      tc.id || synthesizeToolCallId('continuation')
    );
    const toolCallsWithIds = toolCalls.map((tc, idx) => ({ ...tc, id: synthesizedIds[idx] }));

    // Build assistant message with reasoning preserved using centralized utility
    const reasoningToolCalls = toolCallsWithIds as unknown as ReasoningToolCallLike[];
    const assistantMessage = ReasoningPreserver.buildAssistantMessageWithReasoning(
      reasoningToolCalls,
      ''
    ) as unknown as OpenAIMessage;
    assistantMessage.content = this.assistantContent(toolCallsWithIds, undefined, '');

    messages.push(assistantMessage);

    // Add tool result messages with ids matching the assistant's tool_calls
    toolResults.forEach((result, index) => {
      const resultContent = result.success
        ? JSON.stringify(result.result || {})
        : JSON.stringify({ error: result.error || 'Tool execution failed' });

      messages.push({
        role: 'tool',
        tool_call_id: synthesizedIds[index],
        content: resultContent
      });
    });

    return messages;
  }

  /**
   * Append tool execution to existing history (no user message added)
   * Filters out system messages to prevent API errors
   */
  appendToolExecution(
    toolCalls: LLMToolCall[],
    toolResults: ToolExecutionResult[],
    previousMessages: LLMMessage[]
  ): LLMMessage[] {
    // Filter out system messages - they should be handled separately
    const messages: OpenAIMessage[] = (previousMessages as OpenAIMessage[]).filter(msg => msg.role !== 'system');

    // Synthesize ids for any tool calls missing them — assistant tool_calls
    // and tool result tool_call_ids must match.
    const synthesizedIds = toolCalls.map((tc) =>
      tc.id || synthesizeToolCallId('append')
    );
    const toolCallsWithIds = toolCalls.map((tc, idx) => ({ ...tc, id: synthesizedIds[idx] }));

    // Build assistant message with reasoning preserved using centralized utility
    const reasoningToolCalls = toolCallsWithIds as unknown as ReasoningToolCallLike[];
    const assistantMessage = ReasoningPreserver.buildAssistantMessageWithReasoning(
      reasoningToolCalls,
      ''
    ) as unknown as OpenAIMessage;
    assistantMessage.content = this.assistantContent(toolCallsWithIds, undefined, '');

    messages.push(assistantMessage);

    // Add tool result messages with ids matching the assistant's tool_calls
    toolResults.forEach((result, index) => {
      messages.push({
        role: 'tool',
        tool_call_id: synthesizedIds[index],
        content: result.success
          ? JSON.stringify(result.result || {})
          : JSON.stringify({ error: result.error || 'Tool execution failed' })
      });
    });

    return messages;
  }
}
