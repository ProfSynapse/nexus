/**
 * IContextBuilder - Interface for provider-specific conversation context builders
 *
 * Each provider (OpenAI, Anthropic, Google, etc.) has different message formats
 * for conversations and tool calls. This interface defines the contract that
 * all provider-specific builders must implement.
 *
 * Follows Interface Segregation Principle - focused contract for context building.
 */

import { ConversationData, ChatMessage, ToolCall } from '../../../types/chat/ChatTypes';

/**
 * OpenAI-format tool call (for streaming/continuation)
 */
export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  /** Reasoning content from thinking models */
  reasoning?: string;
  /** Thought signature for Google models */
  thoughtSignature?: string;
  /** Source format for custom models */
  sourceFormat?: 'bracket' | 'xml' | 'native';
}

/**
 * Tool execution result
 */
export interface ToolExecutionResult {
  id: string;
  name?: string;
  success: boolean;
  result?: unknown;
  error?: string;
  /** The function details from the original call */
  function?: {
    name: string;
    arguments?: string;
  };
}

/**
 * Content block for Anthropic-style messages
 */
export interface LLMContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

/**
 * Google-specific part types
 */
export interface GoogleTextPart {
  text: string;
}

export interface GoogleFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface GoogleFunctionResponsePart {
  functionResponse: {
    name: string;
    response: unknown;
  };
}

export type GooglePart = GoogleTextPart | GoogleFunctionCallPart | GoogleFunctionResponsePart;

/**
 * Google-format message
 */
export interface GoogleMessage {
  role: 'user' | 'model' | 'function' | 'system';
  parts: GooglePart[];
}

/**
 * OpenAI-format message
 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LLMContentBlock[] | null;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
  name?: string;
}

/**
 * Anthropic-format message
 */
export interface AnthropicMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMContentBlock[];
}

/**
 * Union type for all LLM message formats
 */
export type LLMMessage = OpenAIMessage | AnthropicMessage | GoogleMessage;

// Re-export for convenience
export type { ChatMessage, ToolCall, ConversationData };

/**
 * Provider-specific conversation context builder.
 *
 * **Wire-format normalization contract**: Implementers own all per-provider
 * wire-format normalization for the messages they emit, including (but not
 * limited to) tool_call_id rewriting. Tool-call ids flowing through our
 * conversation store can originate from any provider and therefore may not
 * match the target provider's accepted ID format. Each builder is
 * responsible for translating incoming ids into something its wire protocol
 * will accept, and keeping the rewrite consistent between
 * `assistant.tool_calls[].id` and the paired `tool.tool_call_id`.
 *
 * Example: `OpenAIContextBuilder` normalizes foreign tool_call ids
 * (AWS Bedrock `toolu_bdrk_*`, Anthropic `toolu_*`) to the OpenAI `call_*`
 * format before emitting messages, since Azure-backed OpenRouter routes
 * reject non-`call_*` ids. Future builders with their own constraints
 * (e.g., Mistral's 9-character alphanumeric-only `tool_call_id`) should
 * perform equivalent normalization in their builder, not in upstream
 * services. Keep the rewrite map stable within a single `buildContext`
 * call so assistant/tool pairings stay consistent.
 */
export interface IContextBuilder {
  /**
   * Provider identifier for this builder
   */
  readonly provider: string;

  /**
   * Build LLM-ready conversation context from stored conversation data
   * Used when loading an existing conversation to continue it
   *
   * @param conversation - The stored conversation data with messages and tool calls
   * @param systemPrompt - Optional system prompt to prepend
   * @returns Properly formatted message array for the provider
   */
  buildContext(conversation: ConversationData, systemPrompt?: string): LLMMessage[];

  /**
   * Build tool continuation context for streaming pingpong pattern
   * After tools are executed during streaming, this builds the continuation
   * context to send back to the LLM for the next response.
   *
   * @param userPrompt - Original user prompt
   * @param toolCalls - Tool calls that were detected and executed
   * @param toolResults - Results from tool execution
   * @param previousMessages - Previous conversation messages (optional)
   * @param systemPrompt - System prompt (optional, used by some providers)
   * @returns Continuation context as message array
   */
  buildToolContinuation(
    userPrompt: string,
    toolCalls: LLMToolCall[],
    toolResults: ToolExecutionResult[],
    previousMessages?: LLMMessage[],
    systemPrompt?: string
  ): LLMMessage[];

  /**
   * Append tool execution to existing conversation history
   * Used for accumulating conversation history during recursive tool calls.
   * Does NOT add the user message - only appends tool call and results.
   *
   * @param toolCalls - Tool calls that were executed
   * @param toolResults - Results from tool execution
   * @param previousMessages - Existing conversation history
   * @returns Updated message array with tool execution appended
   */
  appendToolExecution(
    toolCalls: LLMToolCall[],
    toolResults: ToolExecutionResult[],
    previousMessages: LLMMessage[]
  ): LLMMessage[];
}

/**
 * Helper type for message validation
 */
export interface MessageValidationContext {
  msg: ChatMessage;
  isLastMessage: boolean;
}
