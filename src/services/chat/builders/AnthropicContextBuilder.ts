/**
 * AnthropicContextBuilder - Builds conversation context for Anthropic Claude
 *
 * Anthropic format uses:
 * - tool_use blocks within assistant messages
 * - tool_result blocks within user messages
 * - Content arrays instead of simple strings for messages with tool calls
 *
 * Follows Single Responsibility Principle - only handles Anthropic format.
 */

import { IContextBuilder, LLMMessage, LLMToolCall, ToolExecutionResult, AnthropicMessage, LLMContentBlock } from './IContextBuilder';
import { ConversationData, ChatMessage, ToolCall } from '../../../types/chat/ChatTypes';

export class AnthropicContextBuilder implements IContextBuilder {
  readonly provider = 'anthropic';

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
    const messages: AnthropicMessage[] = [];

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
          // Assistant message contains both text AND tool_use blocks
          const content: LLMContentBlock[] = [];

          if (msg.content && msg.content.trim()) {
            content.push({ type: 'text', text: msg.content });
          }

          // Add tool_use blocks
          msg.toolCalls.forEach((toolCall: ToolCall) => {
            content.push({
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.name,
              input: (toolCall.parameters || {}) as Record<string, unknown>
            });
          });

          messages.push({ role: 'assistant', content });

          // Add tool results as user message with tool_result blocks
          const toolResultContent: LLMContentBlock[] = msg.toolCalls.map((toolCall: ToolCall) => ({
            type: 'tool_result' as const,
            tool_use_id: toolCall.id,
            content: toolCall.success
              ? JSON.stringify(toolCall.result || {})
              : `Error: ${toolCall.error || 'Tool execution failed'}`
          }));

          if (toolResultContent.length > 0) {
            messages.push({ role: 'user', content: toolResultContent });
          }
        } else {
          if (msg.content && msg.content.trim()) {
            messages.push({ role: 'assistant', content: msg.content });
          }
        }
      } else if (msg.role === 'tool') {
        // Handle stored tool messages - convert to tool_result blocks
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const toolResultContent: LLMContentBlock[] = msg.toolCalls.map((toolCall: ToolCall) => ({
            type: 'tool_result' as const,
            tool_use_id: toolCall.id,
            content: toolCall.success
              ? JSON.stringify(toolCall.result || {})
              : `Error: ${toolCall.error || 'Tool execution failed'}`
          }));

          if (toolResultContent.length > 0) {
            messages.push({ role: 'user', content: toolResultContent });
          }
        }
      }
    });

    return messages;
  }

  /**
   * Build tool continuation for pingpong pattern
   */
  buildToolContinuation(
    userPrompt: string,
    toolCalls: LLMToolCall[],
    toolResults: ToolExecutionResult[],
    previousMessages?: LLMMessage[],
    _systemPrompt?: string
  ): LLMMessage[] {
    const messages: AnthropicMessage[] = [];

    if (previousMessages && previousMessages.length > 0) {
      messages.push(...(previousMessages as AnthropicMessage[]));
    }

    if (userPrompt) {
      messages.push({ role: 'user', content: userPrompt });
    }

    // Add assistant message with tool_use blocks
    const toolUseBlocks: LLMContentBlock[] = toolCalls.map(tc => ({
      type: 'tool_use' as const,
      id: tc.id,
      name: tc.function?.name || '',
      input: JSON.parse(tc.function?.arguments || '{}') as Record<string, unknown>
    }));

    messages.push({ role: 'assistant', content: toolUseBlocks });

    // Add user message with tool_result blocks
    const toolResultBlocks: LLMContentBlock[] = toolResults.map(result => ({
      type: 'tool_result' as const,
      tool_use_id: result.id,
      content: result.success
        ? JSON.stringify(result.result || {})
        : `Error: ${result.error || 'Tool execution failed'}`
    }));

    messages.push({ role: 'user', content: toolResultBlocks });

    return messages;
  }

  /**
   * Append tool execution to existing history (no user message added)
   */
  appendToolExecution(
    toolCalls: LLMToolCall[],
    toolResults: ToolExecutionResult[],
    previousMessages: LLMMessage[]
  ): LLMMessage[] {
    const messages: AnthropicMessage[] = [...(previousMessages as AnthropicMessage[])];

    // Add assistant message with tool_use blocks
    const toolUseBlocks: LLMContentBlock[] = toolCalls.map(tc => ({
      type: 'tool_use' as const,
      id: tc.id,
      name: tc.function?.name || '',
      input: JSON.parse(tc.function?.arguments || '{}') as Record<string, unknown>
    }));

    messages.push({ role: 'assistant', content: toolUseBlocks });

    // Add user message with tool_result blocks
    const toolResultBlocks: LLMContentBlock[] = toolResults.map(result => ({
      type: 'tool_result' as const,
      tool_use_id: result.id,
      content: result.success
        ? JSON.stringify(result.result || {})
        : `Error: ${result.error || 'Tool execution failed'}`
    }));

    messages.push({ role: 'user', content: toolResultBlocks });

    return messages;
  }
}
