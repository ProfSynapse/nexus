/**
 * Core types for LLM adapters
 * Based on patterns from services/llm/
 */

/**
 * Supported LLM providers
 */
export type SupportedProvider = 'openai' | 'openrouter' | 'anthropic' | 'google' | 'groq' | 'mistral' | 'perplexity' | 'requesty';

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
  onToolEvent?: (event: 'started' | 'completed', data: any) => void;
  // Usage callback for async cost calculation (e.g., OpenRouter streaming)
  onUsageAvailable?: (usage: TokenUsage, cost?: CostDetails) => void;
  // Cache options
  disableCache?: boolean;
  cacheTTL?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  // Pre-detected tool calls for post-stream execution
  detectedToolCalls?: any[];
  // Conversation history for pingpong pattern (overrides prompt-based message building)
  conversationHistory?: any[];
  // OpenAI Responses API: Previous response ID for stateful continuations
  previousResponseId?: string;
}

export interface StreamChunk {
  content: string;
  complete: boolean;
  usage?: TokenUsage;
  toolCalls?: ToolCall[];
  toolCallsReady?: boolean; // True when tool calls are complete and safe to execute
  metadata?: Record<string, any>; // For provider-specific metadata (e.g., OpenAI response ID)
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
  metadata?: Record<string, any>;
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  toolCalls?: ToolCall[];
  webSearchResults?: SearchResult[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // Detailed breakdowns from OpenAI API
  cachedTokens?: number; // Cached input tokens (75-90% discount)
  reasoningTokens?: number; // Hidden reasoning tokens (o1/o3 models)
  audioTokens?: number; // Audio input/output tokens
}

export interface CostDetails {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
  rateInputPerMillion: number;
  rateOutputPerMillion: number;
  cached?: {
    tokens: number;
    cost: number;
  };
}

export interface ModelPricing {
  rateInputPerMillion: number;
  rateOutputPerMillion: number;
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
    parameters: Record<string, any>;
  };
}

export interface ToolCall {
  id: string;
  type: string;
  function?: {
    name: string;
    arguments: string;
  };
  // OpenRouter: reasoning_details for Gemini models (must be preserved in continuations)
  reasoning_details?: any[];
  // Google Gemini: thought_signature for thinking models
  thought_signature?: string;
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