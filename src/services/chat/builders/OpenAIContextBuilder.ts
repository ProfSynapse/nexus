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

export class OpenAIContextBuilder implements IContextBuilder {
  readonly provider = 'openai';

  /**
   * Validate if a message should be included in LLM context
   */
  private isValidForContext(msg: ChatMessage, isLastMessage: boolean): boolean {
    if (msg.state === 'invalid' || msg.state === 'streaming') return false;
    if (msg.role === 'user' && (!msg.content || !msg.content.trim())) return false;

    if (msg.role === 'assistant') {
      const hasContent = msg.content && msg.content.trim();
      const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;

      if (!hasContent && !hasToolCalls && !isLastMessage) return false;

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
          // Build proper OpenAI tool_calls format for continuations
          const toolCallsFormatted: LLMToolCall[] = msg.toolCalls.map((tc: ToolCall) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function?.name || tc.name || '',
              arguments: tc.function?.arguments || JSON.stringify(tc.parameters || {})
            }
          }));

          // Assistant message with tool_calls array (content can be empty or text)
          messages.push({
            role: 'assistant',
            content: msg.content || '',
            tool_calls: toolCallsFormatted
          });

          // Add tool result messages with proper tool_call_id
          msg.toolCalls.forEach((toolCall: ToolCall) => {
            const resultContent = toolCall.success !== false
              ? JSON.stringify(toolCall.result || {})
              : JSON.stringify({ error: toolCall.error || 'Tool execution failed' });

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: resultContent
            });
          });
        } else {
          if (msg.content && msg.content.trim()) {
            messages.push({ role: 'assistant', content: msg.content });
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

    // Build assistant message with reasoning preserved using centralized utility
    const assistantMessage = ReasoningPreserver.buildAssistantMessageWithReasoning(toolCalls, null);

    messages.push(assistantMessage as OpenAIMessage);

    // Add tool result messages
    toolResults.forEach((result, index) => {
      const toolCall = toolCalls[index];
      const resultContent = result.success
        ? JSON.stringify(result.result || {})
        : JSON.stringify({ error: result.error || 'Tool execution failed' });

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
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

    // Build assistant message with reasoning preserved using centralized utility
    const assistantMessage = ReasoningPreserver.buildAssistantMessageWithReasoning(toolCalls, null);

    messages.push(assistantMessage as OpenAIMessage);

    // Add tool result messages
    toolResults.forEach((result, index) => {
      const toolCall = toolCalls[index];
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result.success
          ? JSON.stringify(result.result || {})
          : JSON.stringify({ error: result.error || 'Tool execution failed' })
      });
    });

    return messages;
  }
}
