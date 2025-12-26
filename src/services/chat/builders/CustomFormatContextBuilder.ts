/**
 * CustomFormatContextBuilder - Builds conversation context for fine-tuned local LLMs
 *
 * Used by: LM Studio, Ollama, WebLLM
 *
 * Preserves the original tool call format the model used:
 * - [TOOL_CALLS][...][/TOOL_CALLS] (Mistral/bracket format)
 * - <tool_call>...</tool_call> (Qwen/XML format)
 *
 * Strict user/assistant alternation required.
 * Raw JSON tool results to match training data.
 *
 * Follows Single Responsibility Principle - only handles custom text format.
 */

import { IContextBuilder } from './IContextBuilder';
import { ConversationData, ToolCallFormat } from '../../../types/chat/ChatTypes';

export class CustomFormatContextBuilder implements IContextBuilder {
  readonly provider = 'custom';

  /**
   * Format tool calls using the format the model originally used
   * Preserves bracket format for Mistral-based, XML format for Qwen-based models
   */
  private formatToolCalls(toolCalls: any[], format?: ToolCallFormat): string {
    const toolCallObjs = toolCalls.map((tc: any) => ({
      name: tc.name,
      arguments: tc.parameters || {}
    }));

    // Default to bracket format if not specified (legacy behavior)
    const effectiveFormat = format || toolCalls[0]?.sourceFormat || 'bracket';

    if (effectiveFormat === 'xml') {
      // Qwen/XML format: <tool_call>...</tool_call>
      return toolCallObjs.map(obj =>
        `<tool_call>\n${JSON.stringify(obj, null, 2)}\n</tool_call>`
      ).join('\n');
    }

    // Bracket format: [TOOL_CALLS][...][/TOOL_CALLS]
    const jsonArray = toolCallObjs.map(obj => JSON.stringify(obj));
    return `[TOOL_CALLS][${jsonArray.join(',')}][/TOOL_CALLS]`;
  }

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
   * Uses OpenAI-like format for context loading (simpler)
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
          // Format using the model's original format
          messages.push({
            role: 'assistant',
            content: this.formatToolCalls(msg.toolCalls)
          });

          // Add tool results as user message
          const toolResultObjects = msg.toolCalls.map((tc: any) => {
            return tc.success
              ? (tc.result || {})
              : { error: tc.error || 'Tool execution failed' };
          });
          messages.push({
            role: 'user',
            content: JSON.stringify(toolResultObjects.length === 1 ? toolResultObjects[0] : toolResultObjects, null, 2)
          });

          // If there's final content after tool execution, add it
          if (msg.content && msg.content.trim()) {
            messages.push({ role: 'assistant', content: msg.content });
          }
        } else {
          if (msg.content && msg.content.trim()) {
            messages.push({ role: 'assistant', content: msg.content });
          }
        }
      }
    });

    return messages;
  }

  /**
   * Build tool continuation for pingpong pattern
   * LM Studio requires STRICT alternation: user/assistant/user/assistant
   */
  buildToolContinuation(
    userPrompt: string,
    toolCalls: any[],
    toolResults: any[],
    previousMessages?: any[],
    _systemPrompt?: string
  ): any[] {
    const messages: any[] = [];

    // Separate system messages from conversation messages
    const systemMessages: any[] = [];
    const conversationMessages: any[] = [];

    if (previousMessages && previousMessages.length > 0) {
      for (const msg of previousMessages) {
        if (msg.role === 'system') {
          systemMessages.push(msg);
        } else {
          conversationMessages.push(msg);
        }
      }
    }

    // Add system messages first
    messages.push(...systemMessages);

    // Check if user prompt already exists in conversation history
    const hasUserPrompt = conversationMessages.some(
      msg => msg.role === 'user' && msg.content === userPrompt
    );

    // If user prompt isn't in history, add it first (after system)
    if (!hasUserPrompt && userPrompt) {
      messages.push({ role: 'user', content: userPrompt });
    }

    // Add existing conversation history
    for (const msg of conversationMessages) {
      // Skip if this is the user prompt we already added
      if (msg.role === 'user' && msg.content === userPrompt && !hasUserPrompt) {
        continue;
      }
      messages.push(msg);
    }

    // Check last message for duplicate detection
    const lastMsg = messages[messages.length - 1];

    // Normalize tool calls for formatting
    const normalizedToolCalls = toolCalls.map(toolCall => {
      const toolName = toolCall.function?.name || toolCall.name || 'unknown';
      const args = toolCall.function?.arguments || toolCall.arguments || '{}';
      const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
      return {
        name: toolName,
        parameters: parsedArgs,
        sourceFormat: toolCall.sourceFormat
      };
    });

    // Detect format from first tool call, or check if it's XML-style
    const format = normalizedToolCalls[0]?.sourceFormat;
    const assistantToolCallContent = this.formatToolCalls(normalizedToolCalls, format);

    // Only add assistant tool call if we don't already end with one
    const lastIsMatchingAssistant = lastMsg &&
      lastMsg.role === 'assistant' &&
      (lastMsg.content?.includes('[TOOL_CALLS]') || lastMsg.content?.includes('<tool_call>'));

    if (!lastIsMatchingAssistant) {
      messages.push({
        role: 'assistant',
        content: assistantToolCallContent
      });
    }

    // Format tool results - raw JSON to match training format
    const toolResultObjects = toolResults.map(result => {
      return result.success
        ? (result.result || {})
        : { error: result.error || 'Tool execution failed' };
    });

    // Add user message with tool results
    messages.push({
      role: 'user',
      content: JSON.stringify(toolResultObjects.length === 1 ? toolResultObjects[0] : toolResultObjects, null, 2)
    });

    return messages;
  }

  /**
   * Append tool execution to existing history (no user message added)
   */
  appendToolExecution(
    toolCalls: any[],
    toolResults: any[],
    previousMessages: any[]
  ): any[] {
    const messages = [...previousMessages];

    // Normalize tool calls for formatting
    const normalizedToolCalls = toolCalls.map(toolCall => {
      const toolName = toolCall.function?.name || toolCall.name || 'unknown';
      const args = toolCall.function?.arguments || toolCall.arguments || '{}';
      const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
      return {
        name: toolName,
        parameters: parsedArgs,
        sourceFormat: toolCall.sourceFormat
      };
    });

    // Detect format from first tool call
    const format = normalizedToolCalls[0]?.sourceFormat;

    messages.push({
      role: 'assistant',
      content: this.formatToolCalls(normalizedToolCalls, format)
    });

    // Format tool results - raw JSON to match training format
    const toolResultObjects = toolResults.map(result => {
      return result.success
        ? (result.result || {})
        : { error: result.error || 'Tool execution failed' };
    });

    messages.push({
      role: 'user',
      content: JSON.stringify(toolResultObjects.length === 1 ? toolResultObjects[0] : toolResultObjects, null, 2)
    });

    return messages;
  }
}
