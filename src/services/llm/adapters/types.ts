/**
 * Core types for LLM adapters
 * Based on patterns from services/llm/
 */

import type { AnthropicThinkingBlock } from '../../../types/llm/ProviderTypes';

/**
 * Supported LLM providers
 */
export type SupportedProvider = 'openai' | 'openai-codex' | 'openrouter' | 'anthropic' | 'anthropic-claude-code' | 'google' | 'google-gemini-cli' | 'github-copilot' | 'deepseek' | 'groq' | 'mistral' | 'perplexity' | 'requesty';

export interface GenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  jsonMode?: boolean;
  stream?: boolean;
  stopSequences?: string[];
  enableThinking?: boolean;
  enableInteractiveThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
  tools?: Tool[];
  enableTools?: boolean;
  webSearch?: boolean;
  fileSearch?: boolean;
  // Tool event callback for live UI updates
  onToolEvent?: (event: 'started' | 'completed', data: unknown) => void;
  // Usage callback for async cost calculation (e.g., OpenRouter streaming)
  onUsageAvailable?: (usage: TokenUsage, cost?: CostDetails) => void;
  // Cache options
  disableCache?: boolean;
  cacheTTL?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  // Pre-detected tool calls for post-stream execution
  detectedToolCalls?: ToolCall[];
  // Conversation history for pingpong pattern (overrides prompt-based message building)
  conversationHistory?: Array<Record<string, unknown>>;
  // OpenAI Responses API: Previous response ID for stateful continuations
  previousResponseId?: string;
}

export interface StreamChunk {
  content: string;
  complete: boolean;
  usage?: TokenUsage;
  toolCalls?: ToolCall[];
  toolCallsReady?: boolean; // True when tool calls are complete and safe to execute
  metadata?: Record<string, unknown>; // For provider-specific metadata (e.g., OpenAI response ID)
  // Reasoning/thinking support (Claude, GPT-5, Gemini, etc.)
  reasoning?: string;           // Incremental reasoning text
  reasoningComplete?: boolean;  // True when reasoning finished
  reasoningId?: string;         // Unique ID for the reasoning block (OpenAI)
  reasoningEncryptedContent?: string; // OpenAI: encrypted_content for multi-turn preservation
}

export interface SearchResult {
  title: string;
  url: string;
  date?: string;
}

export interface LLMResponse {
  text: string;
  model: string;
  provider?: string;
  usage?: TokenUsage;
  cost?: CostDetails;
  metadata?: Record<string, unknown>;
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  toolCalls?: ToolCall[];
  webSearchResults?: SearchResult[];
}

/**
 * Token usage as reported by the provider, in one shape for every provider.
 *
 * `promptTokens` is ALL input tokens including cache reads and writes.
 * Anthropic reports `input_tokens` net of both; the adapter adds them back so
 * context accounting and the four-class cost arithmetic agree across providers.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Input tokens served from the provider's prompt cache (discounted). */
  cacheReadTokens?: number;
  /** Input tokens written to the provider's prompt cache (Anthropic charges a premium). */
  cacheWriteTokens?: number;
  /** Alias of cacheReadTokens (kept for stored messages and older callers); prefer cacheReadTokens. */
  cachedTokens?: number;
  reasoningTokens?: number; // Hidden reasoning tokens
  audioTokens?: number; // Audio input/output tokens
  /** Price the provider itself reported for this response (OpenRouter, Requesty). Wins over any local rate table. */
  providerCost?: {
    totalCost: number;
    currency: string;
  };
}

export interface CostDetails {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
  rateInputPerMillion: number;
  rateOutputPerMillion: number;
  /** Cache-read share of inputCost. */
  cacheRead?: {
    tokens: number;
    cost: number;
    ratePerMillion: number;
  };
  /** Cache-write share of inputCost. */
  cacheWrite?: {
    tokens: number;
    cost: number;
    ratePerMillion: number;
  };
  /** Alias of cacheRead (tokens, cost) for older readers; prefer cacheRead. */
  cached?: {
    tokens: number;
    cost: number;
  };
  /** True when totalCost came from the provider rather than the rate table. */
  providerReported?: boolean;
}

export interface ModelPricing {
  rateInputPerMillion: number;
  rateOutputPerMillion: number;
  /** Omitted = charged at the input rate (no discount is assumed, never guessed). */
  rateCacheReadPerMillion?: number;
  /** Omitted = charged at the input rate. */
  rateCacheWritePerMillion?: number;
  currency: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens?: number;
  supportsJSON: boolean;
  supportsImages: boolean;
  supportsFunctions: boolean;
  supportsStreaming: boolean;
  supportsThinking?: boolean;
  supportsImageGeneration?: boolean;
  pricing: {
    inputPerMillion: number;
    outputPerMillion: number;
    imageGeneration?: number;
    currency: string;
    lastUpdated: string; // ISO date string
  };
}

export interface Tool {
  type: 'function' | 'web_search' | 'file_search' | 'code_execution';
  function?: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Format the model used to output tool calls */
export type ToolCallFormat = 'bracket' | 'xml' | 'native';

export interface ToolCall {
  id: string;
  type: 'function';
  index?: number;
  name?: string;
  displayName?: string;
  technicalName?: string;
  function: {
    name: string;
    arguments: string;
  };
  parameters?: Record<string, unknown>;
  result?: unknown;
  success?: boolean;
  error?: string;
  providerExecuted?: boolean;
  // OpenRouter: reasoning_details for Gemini models (must be preserved in continuations)
  reasoning_details?: Array<Record<string, unknown>>;
  // Google Gemini: thought_signature for thinking models
  thought_signature?: string;
  // Anthropic: exact signed/redacted blocks required for tool continuations.
  anthropic_thinking_blocks?: AnthropicThinkingBlock[];
  /** Format the model used: 'bracket' = [TOOL_CALLS], 'xml' = <tool_call>, 'native' = OpenAI */
  sourceFormat?: ToolCallFormat;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  organizationId?: string;
  projectId?: string;
  customHeaders?: Record<string, string>;
}

export interface ProviderCapabilities {
  supportsStreaming: boolean;
  streamingMode?: 'streaming' | 'live' | 'buffered' | 'none';
  supportsJSON: boolean;
  supportsImages: boolean;
  supportsFunctions: boolean;
  supportsThinking: boolean;
  supportsImageGeneration?: boolean;
  maxContextWindow: number;
  supportedFeatures: string[];
}

export class LLMProviderError extends Error {
  constructor(
    message: string,
    public provider: string,
    public code?: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'LLMProviderError';
  }
}
