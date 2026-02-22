/**
 * ProviderMessageBuilder - Provider-specific message formatting
 *
 * Handles building conversation history and continuation options for different
 * LLM providers (Anthropic, Google, OpenAI, generic OpenAI-compatible).
 *
 * Each provider has specific message format requirements:
 * - Anthropic: tool_use/tool_result blocks in messages
 * - Google: functionCall/functionResponse in parts
 * - OpenAI: Responses API with function_call_output items
 * - Generic: Chat Completions API message arrays
 */

import { ConversationContextBuilder } from '../../chat/ConversationContextBuilder';
import { ToolResult } from '../adapters/shared/ToolExecutionUtils';
import { Tool, ToolCall as AdapterToolCall } from '../adapters/types';
import { ToolCall as ChatToolCall } from '../../../types/chat/ChatTypes';

// Union type for tool calls from different sources
type ToolCallUnion = AdapterToolCall | ChatToolCall;

// Standardized message format for conversation history
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCallUnion[];
}

// Google-specific message format
export interface GoogleMessage {
  role: 'user' | 'model' | 'function';
  parts: Array<{ text?: string; functionCall?: any; functionResponse?: any }>;
}

// Internal options type used during streaming orchestration
export interface GenerateOptionsInternal {
  model: string;
  systemPrompt?: string;
  conversationHistory?: GoogleMessage[] | ConversationMessage[] | any[]; // any[] for OpenAI Responses API
  tools?: Tool[];
  onToolEvent?: (event: 'started' | 'completed', data: any) => void;
  onUsageAvailable?: (usage: any, cost?: any) => void;
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
  previousResponseId?: string; // OpenAI Responses API
}

export interface StreamingOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  tools?: Tool[];
  onToolEvent?: (event: 'started' | 'completed', data: any) => void;
  onUsageAvailable?: (usage: any, cost?: any) => void;
  sessionId?: string;
  workspaceId?: string;
  conversationId?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
  // Responses API (OpenAI/LM Studio): ID from first response, reused for all continuations
  responsesApiId?: string;
  // Callback when responsesApiId is first captured - caller should persist to conversation metadata
  onResponsesApiId?: (id: string) => void;
}

export class ProviderMessageBuilder {
  private conversationResponseIds: Map<string, string>;

  constructor(conversationResponseIds: Map<string, string>) {
    this.conversationResponseIds = conversationResponseIds;
  }

  /**
   * Extract system prompt from messages array
   * Most LLM providers expect system prompt as a separate option, not in messages array.
   * This method finds system messages and combines them into a single prompt.
   * @param messages - Array of messages that may contain system messages
   * @param existingSystemPrompt - Optional existing system prompt to prepend
   * @returns Combined system prompt or undefined if none found
   */
  static extractSystemPrompt(messages: ConversationMessage[], existingSystemPrompt?: string): string | undefined {
    const systemMessages = messages.filter(m => m.role === 'system');
    const systemContent = systemMessages.map(m => m.content).filter(Boolean).join('\n\n');

    if (existingSystemPrompt && systemContent) {
      return `${existingSystemPrompt}\n\n${systemContent}`;
    }
    return existingSystemPrompt || systemContent || undefined;
  }

  /**
   * Filter out system messages from array
   * Use this to get only user/assistant/tool messages for the messages array.
   * @param messages - Array of messages
   * @returns Messages without system role
   */
  static filterNonSystemMessages(messages: ConversationMessage[]): ConversationMessage[] {
    return messages.filter(m => m.role !== 'system');
  }

  /**
   * Build conversation history string from messages (for text-based providers)
   */
  buildConversationHistory(messages: ConversationMessage[]): string {
    if (messages.length <= 1) {
      return '';
    }

    return messages.slice(0, -1).map((msg: ConversationMessage) => {
      if (msg.role === 'user') return `User: ${msg.content}`;
      if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          return `Assistant: [Calling tools: ${msg.tool_calls.map((tc) => {
            // Handle both AdapterToolCall and ChatToolCall
            if ('name' in tc) {
              const chatTc = tc as ChatToolCall;
              if (chatTc.name) return chatTc.name;
            }
            return tc.function?.name || 'unknown';
          }).join(', ')}]`;
        }
        return `Assistant: ${msg.content}`;
      }
      if (msg.role === 'tool') return `Tool Result: ${msg.content}`;
      if (msg.role === 'system') return `System: ${msg.content}`;
      return '';
    }).filter(Boolean).join('\n');
  }

  /**
   * Build continuation options with provider-specific formatting
   */
  buildContinuationOptions(
    provider: string,
    userPrompt: string,
    toolCalls: ToolCallUnion[],
    toolResults: ToolResult[],
    previousMessages: ConversationMessage[],
    generateOptions: GenerateOptionsInternal,
    options?: StreamingOptions
  ): GenerateOptionsInternal {
    // Check if this is an Anthropic model (direct only)
    // Note: OpenRouter always uses OpenAI format, even for Anthropic models
    const isAnthropicModel = provider === 'anthropic';

    // Check if this is a Google model (direct only)
    // Note: OpenRouter always uses OpenAI format, even for Google models
    const isGoogleModel = provider === 'google';

    if (isAnthropicModel) {
      // Build proper Anthropic messages with tool_use and tool_result blocks
      const conversationHistory = ConversationContextBuilder.buildToolContinuation(
        'anthropic',
        userPrompt,
        toolCalls,
        toolResults,
        previousMessages,
        generateOptions.systemPrompt
      ) as ConversationMessage[];

      // IMPORTANT: Disable thinking for tool continuations
      // Anthropic requires assistant messages to start with a thinking block when thinking is enabled,
      // but we don't have access to the original thinking content here.
      return {
        ...generateOptions,
        conversationHistory,
        systemPrompt: generateOptions.systemPrompt,
        enableThinking: false // Disable thinking for tool continuations
      };
    } else if (isGoogleModel) {
      // Build proper Google/Gemini conversation history with functionCall and functionResponse
      const conversationHistory = ConversationContextBuilder.buildToolContinuation(
        'google',
        userPrompt,
        toolCalls,
        toolResults,
        previousMessages,
        generateOptions.systemPrompt
      ) as GoogleMessage[];

      return {
        ...generateOptions,
        conversationHistory,
        systemPrompt: generateOptions.systemPrompt
      };
    } else if (provider === 'openai-codex') {
      // Codex uses stateless Responses API — no previous_response_id.
      // Build a full input array: prior messages + user prompt + function_call + function_call_output items.
      const inputItems: Array<Record<string, unknown>> = [];

      // Add prior conversation messages
      for (const msg of previousMessages) {
        if (msg.role === 'system') continue; // system prompt goes in instructions
        inputItems.push({ role: msg.role, content: msg.content });
      }

      // Add current user prompt
      if (userPrompt) {
        inputItems.push({ role: 'user', content: userPrompt });
      }

      // Add function_call items (what the model called)
      for (const tc of toolCalls) {
        const name = ('name' in tc && tc.name) ? tc.name as string : tc.function?.name || '';
        const args = tc.function?.arguments || '{}';
        inputItems.push({
          type: 'function_call',
          call_id: tc.id,
          name,
          arguments: args
        });
      }

      // Add function_call_output items (what the tools returned)
      for (let i = 0; i < toolResults.length; i++) {
        const result = toolResults[i];
        const tc = toolCalls[i];
        inputItems.push({
          type: 'function_call_output',
          call_id: tc?.id || result.id,
          output: result.success
            ? JSON.stringify(result.result || {})
            : JSON.stringify({ error: result.error || 'Tool execution failed' })
        });
      }

      return {
        ...generateOptions,
        conversationHistory: inputItems,
        systemPrompt: generateOptions.systemPrompt,
        tools: generateOptions.tools
      };
    } else if (provider === 'openai') {
      // OpenAI uses Responses API with function_call_output items + previous_response_id
      // State is reliably tracked on OpenAI's servers
      const toolInput = ConversationContextBuilder.buildResponsesAPIToolInput(
        toolCalls,
        toolResults
      );

      // Use responsesApiId from options (loaded from conversation metadata)
      // Falls back to in-memory map for backward compatibility
      let previousResponseId = options?.responsesApiId;
      if (!previousResponseId) {
        const convId = options?.conversationId;
        previousResponseId = convId ? this.conversationResponseIds.get(convId) : undefined;
      }

      return {
        ...generateOptions,
        conversationHistory: toolInput,
        previousResponseId,
        systemPrompt: generateOptions.systemPrompt,
        tools: generateOptions.tools
      };
    } else if (provider === 'lmstudio') {
      // LM Studio: Send FULL conversation history to ensure AI sees complete context
      // Format depends on model: Nexus uses custom <tool_call> format, others use OpenAI format
      const conversationHistory = ConversationContextBuilder.buildToolContinuation(
        'lmstudio',
        userPrompt,
        toolCalls,
        toolResults,
        previousMessages,
        generateOptions.systemPrompt,
        generateOptions.model // Pass model to determine correct format
      ) as ConversationMessage[];

      return {
        ...generateOptions,
        conversationHistory,
        systemPrompt: generateOptions.systemPrompt,
        tools: generateOptions.tools
      };
    } else {
      // Other OpenAI-compatible providers (groq, mistral, perplexity, requesty, openrouter)
      // These still use Chat Completions API message arrays
      const conversationHistory = ConversationContextBuilder.buildToolContinuation(
        provider,
        userPrompt,
        toolCalls,
        toolResults,
        previousMessages,
        generateOptions.systemPrompt
      ) as ConversationMessage[];

      return {
        ...generateOptions,
        conversationHistory,
        systemPrompt: generateOptions.systemPrompt
      };
    }
  }

  /**
   * Build initial generate options for a provider
   * Automatically extracts system messages from the messages array and combines with options.systemPrompt
   */
  buildInitialOptions(
    provider: string,
    model: string,
    messages: ConversationMessage[],
    options?: StreamingOptions
  ): { generateOptions: GenerateOptionsInternal; userPrompt: string } {
    // Extract system messages and filter them out of the messages array
    // This handles cases where system prompt is passed as a message (e.g., subagent branches)
    const extractedSystemPrompt = ProviderMessageBuilder.extractSystemPrompt(messages, options?.systemPrompt);
    const nonSystemMessages = ProviderMessageBuilder.filterNonSystemMessages(messages);

    // Get only the latest user message as the actual prompt
    const latestUserMessage = nonSystemMessages[nonSystemMessages.length - 1];
    const userPrompt = latestUserMessage?.role === 'user' ? latestUserMessage.content : '';

    // Check if this is a Google model
    const isGoogleModel = provider === 'google';

    let generateOptions: GenerateOptionsInternal;

    if (isGoogleModel) {
      // For Google, build proper conversation history in Google format
      const googleConversationHistory: GoogleMessage[] = [];

      for (const msg of nonSystemMessages) {
        if (!msg.content || !msg.content.trim()) {
          continue;
        }

        if (msg.role === 'user') {
          googleConversationHistory.push({
            role: 'user',
            parts: [{ text: msg.content }]
          });
        } else if (msg.role === 'assistant') {
          googleConversationHistory.push({
            role: 'model',
            parts: [{ text: msg.content }]
          });
        }
      }

      generateOptions = {
        model,
        systemPrompt: extractedSystemPrompt,
        conversationHistory: googleConversationHistory,
        tools: options?.tools,
        onToolEvent: options?.onToolEvent,
        onUsageAvailable: options?.onUsageAvailable,
        enableThinking: options?.enableThinking,
        thinkingEffort: options?.thinkingEffort
      };
    } else {
      // For other providers (OpenAI, Anthropic), use text-based system prompt
      const conversationHistory = this.buildConversationHistory(nonSystemMessages);

      const systemPrompt = [
        extractedSystemPrompt || '',
        conversationHistory ? '\n=== Conversation History ===\n' + conversationHistory : ''
      ].filter(Boolean).join('\n');

      generateOptions = {
        model,
        systemPrompt: systemPrompt || extractedSystemPrompt,
        tools: options?.tools,
        onToolEvent: options?.onToolEvent,
        onUsageAvailable: options?.onUsageAvailable,
        enableThinking: options?.enableThinking,
        thinkingEffort: options?.thinkingEffort
      };
    }

    return { generateOptions, userPrompt };
  }

  /**
   * Update response ID for OpenAI provider
   */
  updateResponseId(conversationId: string | undefined, responseId: string): void {
    if (conversationId) {
      this.conversationResponseIds.set(conversationId, responseId);
    }
  }
}
