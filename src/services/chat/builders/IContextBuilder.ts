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
