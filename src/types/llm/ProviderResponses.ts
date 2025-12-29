/**
 * Location: src/types/llm/ProviderResponses.ts
 *
 * LLM Provider Response Types
 * Typed responses for streaming chunks from each provider
 *
 * Relationships:
 * - Used by: All LLM adapters (OpenAIAdapter, AnthropicAdapter, etc.)
 * - Used by: LLMService for type-safe response handling
 * - Used by: StreamingResponseService for chunk processing
 */

// OpenAI Chat Completion Chunk
export interface OpenAIChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage?: OpenAIUsage;
}

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

// Anthropic Stream Events
export interface AnthropicStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop';
  message?: AnthropicMessage;
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: AnthropicDelta;
  usage?: { output_tokens: number };
}

export interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicDelta {
  type?: 'text_delta' | 'input_json_delta';
  text?: string;
  partial_json?: string;
  stop_reason?: string;
}

// Google Gemini Stream Chunk
export interface GeminiStreamChunk {
  candidates?: Array<{
    content: {
      parts: Array<GeminiPart>;
      role: 'model';
    };
    finishReason?: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER';
    safetyRatings?: Array<{ category: string; probability: string }>;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export interface GeminiPart {
  text?: string;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

// Groq (uses OpenAI format)
export type GroqStreamChunk = OpenAIChatChunk;

// Mistral Stream Chunk
export interface MistralStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: MistralToolCallDelta[];
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface MistralToolCallDelta {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

// Union type for all provider chunks
export type ProviderStreamChunk =
  | OpenAIChatChunk
  | AnthropicStreamEvent
  | GeminiStreamChunk
  | MistralStreamChunk;

// Type guards
export function isOpenAIChunk(chunk: unknown): chunk is OpenAIChatChunk {
  return typeof chunk === 'object' && chunk !== null &&
    'object' in chunk && (chunk as OpenAIChatChunk).object === 'chat.completion.chunk';
}

export function isAnthropicEvent(chunk: unknown): chunk is AnthropicStreamEvent {
  return typeof chunk === 'object' && chunk !== null &&
    'type' in chunk && typeof (chunk as AnthropicStreamEvent).type === 'string';
}

export function isGeminiChunk(chunk: unknown): chunk is GeminiStreamChunk {
  return typeof chunk === 'object' && chunk !== null &&
    ('candidates' in chunk || 'usageMetadata' in chunk);
}
