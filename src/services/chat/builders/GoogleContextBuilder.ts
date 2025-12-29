/**
 * GoogleContextBuilder - Builds conversation context for Google Gemini
 *
 * Google format uses:
 * - 'user' and 'model' roles (not 'assistant')
 * - 'parts' array with text, functionCall, or functionResponse objects
 * - thoughtSignature for thinking models (Gemini 3.0+)
 *
 * Follows Single Responsibility Principle - only handles Google format.
 */

import { IContextBuilder, LLMMessage, LLMToolCall, ToolExecutionResult, GoogleMessage, GooglePart } from './IContextBuilder';
import { ConversationData, ChatMessage, ToolCall } from '../../../types/chat/ChatTypes';
import { ReasoningPreserver } from '../../llm/adapters/shared/ReasoningPreserver';

export class GoogleContextBuilder implements IContextBuilder {
  readonly provider = 'google';

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
    const messages: GoogleMessage[] = [];

    // Note: Google uses systemInstruction separately, not in messages
    // But we include it here for compatibility with the interface
    if (systemPrompt) {
      messages.push({ role: 'system', parts: [{ text: systemPrompt }] });
    }

    // Filter valid messages
    const validMessages = conversation.messages.filter((msg, index) => {
      const isLastMessage = index === conversation.messages.length - 1;
      return this.isValidForContext(msg, isLastMessage);
    });

    validMessages.forEach((msg) => {
      if (msg.role === 'user') {
        if (msg.content && msg.content.trim()) {
          messages.push({
            role: 'user',
            parts: [{ text: msg.content }]
          });
        }
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          // Build model message with thought signatures preserved
          const modelMessage = ReasoningPreserver.buildGoogleModelMessageWithThinking(
            msg.toolCalls.map((tc: ToolCall) => ({
              ...tc,
              function: { name: tc.name || '', arguments: JSON.stringify(tc.parameters || {}) }
            }))
          );
          messages.push(modelMessage as GoogleMessage);

          // Function response parts
          const functionResponseParts: GooglePart[] = msg.toolCalls.map((tc: ToolCall) => ({
            functionResponse: {
              name: tc.name || '',
              response: tc.success
                ? (tc.result || {})
                : { error: tc.error || 'Tool execution failed' }
            }
          }));

          messages.push({ role: 'function', parts: functionResponseParts });

          // If there's final content after tool execution, add it
          if (msg.content && msg.content.trim()) {
            messages.push({
              role: 'model',
              parts: [{ text: msg.content }]
            });
          }
        } else {
          if (msg.content && msg.content.trim()) {
            messages.push({
              role: 'model',
              parts: [{ text: msg.content }]
            });
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
    const messages: GoogleMessage[] = [];

    // Add previous conversation history (convert to Google format if needed)
    if (previousMessages && previousMessages.length > 0) {
      for (const msg of previousMessages) {
        // Skip messages that are already in Google format
        const googleMsg = msg as GoogleMessage;
        if (googleMsg.parts) {
          messages.push(googleMsg);
          continue;
        }

        // Convert from simple message format
        const simpleMsg = msg as { role: string; content?: string };
        if (simpleMsg.role === 'user' && simpleMsg.content) {
          messages.push({
            role: 'user',
            parts: [{ text: typeof simpleMsg.content === 'string' ? simpleMsg.content : JSON.stringify(simpleMsg.content) }]
          });
        } else if (simpleMsg.role === 'assistant' && simpleMsg.content) {
          messages.push({
            role: 'model',
            parts: [{ text: typeof simpleMsg.content === 'string' ? simpleMsg.content : JSON.stringify(simpleMsg.content) }]
          });
        }
      }
    }

    // Add the original user message
    if (userPrompt) {
      messages.push({
        role: 'user',
        parts: [{ text: userPrompt }]
      });
    }

    // Build model message with thought signatures preserved
    const modelMessage = ReasoningPreserver.buildGoogleModelMessageWithThinking(toolCalls);
    messages.push(modelMessage as GoogleMessage);

    // Add function response parts
    const functionResponseParts: GooglePart[] = toolResults.map(result => ({
      functionResponse: {
        name: result.name || result.function?.name || '',
        response: result.success
          ? (result.result || {})
          : { error: result.error || 'Tool execution failed' }
      }
    }));

    messages.push({
      role: 'user',  // Google uses 'user' role for function responses
      parts: functionResponseParts
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
    const messages: GoogleMessage[] = [...(previousMessages as GoogleMessage[])];

    // Build model message with thought signatures preserved
    const modelMessage = ReasoningPreserver.buildGoogleModelMessageWithThinking(toolCalls);
    messages.push(modelMessage as GoogleMessage);

    // Add function response parts
    const functionResponseParts: GooglePart[] = toolResults.map(result => ({
      functionResponse: {
        name: result.name || result.function?.name || '',
        response: result.success
          ? (result.result || {})
          : { error: result.error || 'Tool execution failed' }
      }
    }));

    messages.push({
      role: 'user',
      parts: functionResponseParts
    });

    return messages;
  }
}
