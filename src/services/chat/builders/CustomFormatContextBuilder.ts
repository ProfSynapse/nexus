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

import { IContextBuilder, LLMMessage, LLMToolCall, ToolExecutionResult, OpenAIMessage } from './IContextBuilder';
import { ConversationData, ChatMessage, ToolCall, ToolCallFormat } from '../../../types/chat/ChatTypes';

export class CustomFormatContextBuilder implements IContextBuilder {
  readonly provider = 'custom';

  /**
   * Format tool calls using the format the model originally used
   * Preserves bracket format for Mistral-based, XML format for Qwen-based models
   */
  private formatToolCalls(toolCalls: Array<{ name?: string; parameters?: Record<string, unknown>; sourceFormat?: ToolCallFormat }>, format?: ToolCallFormat): string {
    const toolCallObjs = toolCalls.map((tc) => ({
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
   * Uses OpenAI-like format for context loading (simpler)
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
          // Detect format from the stored tool calls
          const format = msg.toolCalls[0]?.sourceFormat;

          // Format using the model's original format
          messages.push({
            role: 'assistant',
            content: this.formatToolCalls(msg.toolCalls, format)
          });

          // Add tool results with appropriate format wrapper
          const toolResults = msg.toolCalls.map((tc: ToolCall) => ({
            success: tc.success !== false,
            result: tc.result,
            error: tc.error
          }));
          messages.push({
            role: 'user',
            content: this.formatToolResults(toolResults, format)
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
   * Format tool results with appropriate wrapper based on tool call format
   * XML format uses <tool_result> tags, bracket format uses raw JSON
   */
  private formatToolResults(toolResults: Array<{ success?: boolean; result?: unknown; error?: string }>, format?: ToolCallFormat): string {
    const toolResultObjects = toolResults.map(result => {
      return result.success
        ? (result.result || {})
        : { error: result.error || 'Tool execution failed' };
    });

    const jsonContent = JSON.stringify(
      toolResultObjects.length === 1 ? toolResultObjects[0] : toolResultObjects,
      null,
      2
    );

    // For XML format, wrap results to match model's expectations
    if (format === 'xml') {
      return `<tool_result>\n${jsonContent}\n</tool_result>`;
    }

    // Bracket format uses raw JSON
    return jsonContent;
  }

  /**
   * Build tool continuation for pingpong pattern
   * LM Studio requires STRICT alternation: user/assistant/user/assistant
   */
  buildToolContinuation(
    userPrompt: string,
    toolCalls: LLMToolCall[],
    toolResults: ToolExecutionResult[],
    previousMessages?: LLMMessage[],
    _systemPrompt?: string
  ): LLMMessage[] {
    const messages: OpenAIMessage[] = [];

    // Separate system messages from conversation messages
    const systemMessages: OpenAIMessage[] = [];
    const conversationMessages: OpenAIMessage[] = [];

    if (previousMessages && previousMessages.length > 0) {
      for (const msg of previousMessages) {
        const openAIMsg = msg as OpenAIMessage;
        if (openAIMsg.role === 'system') {
          systemMessages.push(openAIMsg);
        } else {
          conversationMessages.push(openAIMsg);
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
      const toolName = toolCall.function?.name || 'unknown';
      const args = toolCall.function?.arguments || '{}';
      const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
      return {
        name: toolName,
        parameters: parsedArgs as Record<string, unknown>,
        sourceFormat: toolCall.sourceFormat
      };
    });

    // Detect format from first tool call
    const format = normalizedToolCalls[0]?.sourceFormat;
    const assistantToolCallContent = this.formatToolCalls(normalizedToolCalls, format);

    // Only add assistant tool call if we don't already end with one
    const lastContent = typeof lastMsg?.content === 'string' ? lastMsg.content : '';
    const lastIsMatchingAssistant = lastMsg &&
      lastMsg.role === 'assistant' &&
      (lastContent.includes('[TOOL_CALLS]') || lastContent.includes('<tool_call>'));

    if (!lastIsMatchingAssistant) {
      messages.push({
        role: 'assistant',
        content: assistantToolCallContent
      });
    }

    // Add user message with tool results (formatted based on tool call format)
    messages.push({
      role: 'user',
      content: this.formatToolResults(toolResults, format)
    });

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
    const messages: OpenAIMessage[] = [...(previousMessages as OpenAIMessage[])];

    // Normalize tool calls for formatting
    const normalizedToolCalls = toolCalls.map(toolCall => {
      const toolName = toolCall.function?.name || 'unknown';
      const args = toolCall.function?.arguments || '{}';
      const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
      return {
        name: toolName,
        parameters: parsedArgs as Record<string, unknown>,
        sourceFormat: toolCall.sourceFormat
      };
    });

    // Detect format from first tool call
    const format = normalizedToolCalls[0]?.sourceFormat;

    messages.push({
      role: 'assistant',
      content: this.formatToolCalls(normalizedToolCalls, format)
    });

    // Add tool results with appropriate format
    messages.push({
      role: 'user',
      content: this.formatToolResults(toolResults, format)
    });

    return messages;
  }
}
