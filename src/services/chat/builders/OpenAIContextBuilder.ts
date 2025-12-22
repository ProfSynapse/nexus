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

import { IContextBuilder } from './IContextBuilder';
import { ConversationData } from '../../../types/chat/ChatTypes';
import { ReasoningPreserver } from '../../llm/adapters/shared/ReasoningPreserver';

export class OpenAIContextBuilder implements IContextBuilder {
  readonly provider = 'openai';

  /**
   * Validate if a message should be included in LLM context
   */
  private isValidForContext(msg: any, isLastMessage: boolean): boolean {
    if (msg.state === 'invalid' || msg.state === 'streaming') return false;
    if (msg.role === 'user' && (!msg.content || !msg.content.trim())) return false;

    if (msg.role === 'assistant') {
      const hasContent = msg.content && msg.content.trim();
      const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;

      if (!hasContent && !hasToolCalls && !isLastMessage) return false;

      if (hasToolCalls) {
        const allHaveResults = msg.toolCalls.every((tc: any) =>
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
  buildContext(conversation: ConversationData, systemPrompt?: string): any[] {
    const messages: any[] = [];

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
          const toolCallsFormatted = msg.toolCalls.map((tc: any) => ({
            id: tc.id,
            type: 'function',
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
          msg.toolCalls.forEach((toolCall: any) => {
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
        const toolCallId = (msg as any).metadata?.toolCallId;
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
    toolCalls: any[],
    toolResults: any[],
    previousMessages?: any[],
    systemPrompt?: string
  ): any[] {
    const messages: any[] = [];

    // Filter out system messages - OpenAI/OpenRouter expect them in a separate systemPrompt param
    if (previousMessages && previousMessages.length > 0) {
      const nonSystemMessages = previousMessages.filter(msg => msg.role !== 'system');
      messages.push(...nonSystemMessages);
    }

    if (userPrompt) {
      messages.push({ role: 'user', content: userPrompt });
    }

    // Build assistant message with reasoning preserved using centralized utility
    const assistantMessage = ReasoningPreserver.buildAssistantMessageWithReasoning(toolCalls, null);

    messages.push(assistantMessage);

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
    toolCalls: any[],
    toolResults: any[],
    previousMessages: any[]
  ): any[] {
    // Filter out system messages - they should be handled separately
    const messages = previousMessages.filter(msg => msg.role !== 'system');

    // Build assistant message with reasoning preserved using centralized utility
    const assistantMessage = ReasoningPreserver.buildAssistantMessageWithReasoning(toolCalls, null);

    messages.push(assistantMessage);

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
