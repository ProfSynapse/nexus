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
import { Tool } from '../adapters/types';
import type { ToolCall as ChatToolCall } from '../../../types/chat/ChatTypes';
import { shouldPassToolSchemasToProvider } from '../utils/ToolSchemaSupport';
import { synthesizeToolCallId } from '../utils/toolCallId';
import type { ToolExecutionOrigin } from '../../../types/tools/ToolOperationTypes';
import { getMessageText, type ConversationMessage, type ToolCallUnion } from './ConversationMessage';
import { toResponsesInputItems } from '../adapters/shared/OpenAIResponsesInput';

// The message type lives in ./ConversationMessage; re-exported so existing
// imports keep resolving.
export { getMessageText };
export type { ConversationMessage, ToolCallUnion };

/**
 * Providers that cannot take a messages array. Their adapters shell out to a
 * CLI that accepts one prompt string plus a system prompt, so prior turns are
 * rendered as a text transcript — the only place that fallback survives.
 */
export const TEXT_HISTORY_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic-claude-code',
  'google-gemini-cli'
]);

// Google-specific message format
export interface GoogleMessage {
  role: 'user' | 'model' | 'function';
  parts: Array<GoogleMessagePart>;
}

interface GoogleFunctionCall {
  name?: string;
  args?: string;
}

interface GoogleFunctionResponse {
  name?: string;
  response?: Record<string, unknown>;
}

interface GoogleMessagePart {
  text?: string;
  functionCall?: GoogleFunctionCall;
  functionResponse?: GoogleFunctionResponse;
}

interface OpenAIContinuationItem {
  role?: 'user' | 'assistant' | 'tool' | 'system';
  content?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

// Internal options type used during streaming orchestration
export interface GenerateOptionsInternal {
  model: string;
  systemPrompt?: string;
  conversationHistory?: GoogleMessage[] | ConversationMessage[] | OpenAIContinuationItem[];
  tools?: Tool[];
  onToolEvent?: (event: 'started' | 'completed', data: unknown) => void;
  onUsageAvailable?: (usage: unknown, cost?: unknown) => void;
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
  previousResponseId?: string; // OpenAI Responses API
}

export interface StreamingOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  tools?: Tool[];
  onToolEvent?: (event: 'started' | 'completed', data: unknown) => void;
  onUsageAvailable?: (usage: unknown, cost?: unknown) => void;
  sessionId?: string;
  workspaceId?: string;
  conversationId?: string;
  messageId?: string;
  turnId?: string;
  operationOrigin?: ToolExecutionOrigin;
  operationScopeId?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  imageProvider?: 'google' | 'openrouter' | 'openai';
  imageModel?: string;
  transcriptionProvider?: string;
  transcriptionModel?: string;
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
    const systemContent = systemMessages.map(m => getMessageText(m)).filter(Boolean).join('\n\n');

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
   * Build conversation history string from messages.
   *
   * Only for TEXT_HISTORY_PROVIDERS — the CLI transports take a prompt string
   * and a system prompt and keep their own session state. Every API-backed
   * provider gets structured turns via `conversationHistory` instead; a text
   * transcript there loses tool arguments, thinking and cache hits.
   */
  buildConversationHistory(messages: ConversationMessage[]): string {
    if (messages.length <= 1) {
      return '';
    }

    return messages.slice(0, -1).map((msg: ConversationMessage) => {
      if (msg.role === 'user') return `User: ${getMessageText(msg)}`;
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
        return `Assistant: ${getMessageText(msg)}`;
      }
      if (msg.role === 'tool') return `Tool Result: ${getMessageText(msg)}`;
      if (msg.role === 'system') return `System: ${getMessageText(msg)}`;
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

      // Keep thinking enabled. AnthropicContextBuilder replays the exact signed
      // thinking/redacted_thinking blocks captured on the tool calls.
      return {
        ...generateOptions,
        conversationHistory,
        systemPrompt: generateOptions.systemPrompt
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
      // Reconstruct prior conversation messages in order. Unlike stateful
      // OpenAI Responses, Codex requires every prior function_call to still have
      // its matching function_call_output in the replayed input array.
      const inputItems: Array<Record<string, unknown>> = toResponsesInputItems(previousMessages, userPrompt);

      // Synthesize ids for any tool calls missing them. Codex/Responses API
      // strictly requires call_id on every function_call and function_call_output.
      const synthesizedIds = toolCalls.map((tc) =>
        tc.id || synthesizeToolCallId('codex')
      );

      // Add function_call items (what the model called)
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        const name = ('name' in tc && tc.name) ? tc.name : tc.function?.name || '';
        const args = tc.function?.arguments || '{}';
        inputItems.push({
          type: 'function_call',
          call_id: synthesizedIds[i],
          name,
          arguments: args
        });
      }

      // Add function_call_output items (what the tools returned) with matching call_id
      for (let i = 0; i < toolResults.length; i++) {
        const result = toolResults[i];
        inputItems.push({
          type: 'function_call_output',
          call_id: synthesizedIds[i] || result.id || `call_synth_codex_result_${Date.now()}_${i}`,
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

      // Prefer the latest in-memory response ID because recursive tool continuations
      // can advance past the value originally loaded from conversation metadata.
      const convId = options?.conversationId;
      const previousResponseId =
        (convId ? this.conversationResponseIds.get(convId) : undefined) ||
        options?.responsesApiId;

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
   *
   * Extracts system messages from the messages array and combines them with
   * options.systemPrompt. Prior turns go to the adapter as structured
   * `conversationHistory` in the shape the provider's context builder already
   * produced; the system prompt carries instructions and context only.
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
    const userPrompt = latestUserMessage?.role === 'user' ? getMessageText(latestUserMessage) : '';

    const shared: Omit<GenerateOptionsInternal, 'model' | 'systemPrompt'> = {
      tools: shouldPassToolSchemasToProvider(provider) ? options?.tools : undefined,
      onToolEvent: options?.onToolEvent,
      onUsageAvailable: options?.onUsageAvailable,
      enableThinking: options?.enableThinking,
      thinkingEffort: options?.thinkingEffort
    };

    let generateOptions: GenerateOptionsInternal;

    if (TEXT_HISTORY_PROVIDERS.has(provider)) {
      // CLI transports: no message array on the wire. Prior turns ride along as
      // a text transcript in the system prompt and the latest message is the prompt.
      const conversationHistory = this.buildConversationHistory(nonSystemMessages);
      const systemPrompt = [
        extractedSystemPrompt || '',
        conversationHistory ? '\n=== Conversation History ===\n' + conversationHistory : ''
      ].filter(Boolean).join('\n');

      generateOptions = {
        model,
        systemPrompt: systemPrompt || extractedSystemPrompt,
        ...shared
      };
    } else if (provider === 'openai' || provider === 'openai-codex') {
      // Responses API: the adapter sends `conversationHistory` verbatim as `input`,
      // so the latest user message is included as the last item.
      generateOptions = {
        model,
        systemPrompt: extractedSystemPrompt,
        conversationHistory: toResponsesInputItems(nonSystemMessages),
        ...shared
      };
    } else if (provider === 'google') {
      // Google adapter uses `conversationHistory` verbatim as `contents`. The
      // builder emits {role, parts}; anything still in {role, content} form
      // (e.g. a user message appended after building) is converted here.
      generateOptions = {
        model,
        systemPrompt: extractedSystemPrompt,
        conversationHistory: nonSystemMessages
          .map(msg => ProviderMessageBuilder.toGoogleMessage(msg))
          .filter((msg): msg is GoogleMessage => msg !== null),
        ...shared
      };
    } else {
      // Anthropic and every chat-completions provider consume `conversationHistory`
      // as their messages array. The last user message is already in it.
      generateOptions = {
        model,
        systemPrompt: extractedSystemPrompt,
        conversationHistory: nonSystemMessages.length > 0 ? nonSystemMessages : undefined,
        ...shared
      };
    }

    return { generateOptions, userPrompt };
  }

  /**
   * Coerce a message to Google's {role, parts} shape. Messages the Google
   * context builder produced pass through; plain {role, content} messages are
   * wrapped; tool-role messages without parts cannot be represented and are dropped.
   */
  private static toGoogleMessage(msg: ConversationMessage): GoogleMessage | null {
    if (Array.isArray(msg.parts) && msg.parts.length > 0) {
      // GoogleContextBuilder already emits Google roles ('model', and 'user'
      // for function responses — Gemini flash models reject the legacy
      // 'function' role); map the generic ones in case a caller appended a
      // plain message with parts.
      const rawRole = msg.role as string;
      const role: GoogleMessage['role'] | 'system' =
        rawRole === 'assistant' ? 'model'
          : rawRole === 'tool' ? 'user'
            : rawRole as GoogleMessage['role'] | 'system';
      if (role === 'system') return null;
      return { role, parts: msg.parts as GoogleMessagePart[] };
    }

    const text = getMessageText(msg);
    if (!text.trim()) return null;

    if (msg.role === 'user') return { role: 'user', parts: [{ text }] };
    if (msg.role === 'assistant') return { role: 'model', parts: [{ text }] };
    return null;
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
