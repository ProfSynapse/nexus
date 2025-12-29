/**
 * Base LLM Adapter
 * Abstract class that all provider adapters extend
 * Based on patterns from services/llm/BaseLLMProvider.ts
 *
 * MOBILE COMPATIBILITY (Dec 2025):
 * - Removed Node.js crypto import
 * - Uses simple djb2 hash for cache keys (not cryptographic, but sufficient)
 */

import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  LLMProviderError,
  ProviderConfig,
  ProviderCapabilities,
  TokenUsage,
  CostDetails,
  ModelPricing,
  SearchResult
} from './types';
import { BaseCache, CacheManager } from '../utils/CacheManager';
import { LLMCostCalculator } from '../utils/LLMCostCalculator';
import { TokenUsageExtractor } from '../utils/TokenUsageExtractor';
import { SchemaValidator } from '../utils/SchemaValidator';
import { SSEStreamProcessor } from '../streaming/SSEStreamProcessor';
import { StreamChunkProcessor } from '../streaming/StreamChunkProcessor';

// Browser-compatible hash function (djb2 algorithm)
// Not cryptographically secure but sufficient for cache keys
function generateHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

export abstract class BaseAdapter {
  abstract readonly name: string;
  abstract readonly baseUrl: string;
  
  protected apiKey: string;
  protected currentModel: string;
  protected config: ProviderConfig;
  protected cache!: BaseCache<LLMResponse>;

  constructor(apiKey: string, defaultModel: string, baseUrl?: string, requiresApiKey: boolean = true) {
    this.apiKey = apiKey || '';
    this.currentModel = defaultModel;

    this.config = {
      apiKey: this.apiKey,
      baseUrl: baseUrl || ''
    };
  }

  protected initializeCache(cacheConfig?: any): void {
    const cacheName = `${this.name}-responses`;
    // getLRUCache creates a new cache if it doesn't exist
    this.cache = CacheManager.getLRUCache<LLMResponse>(cacheName, {
      maxSize: cacheConfig?.maxSize || 1000,
      defaultTTL: cacheConfig?.defaultTTL || 3600000, // 1 hour
      ...cacheConfig
    });
  }

  // Abstract methods that each provider must implement
  abstract generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse>;
  abstract generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown>;
  abstract listModels(): Promise<ModelInfo[]>;
  abstract getCapabilities(): ProviderCapabilities;
  abstract getModelPricing(modelId: string): Promise<ModelPricing | null>;

  /**
   * Centralized SSE streaming processor using eventsource-parser
   * Delegates to SSEStreamProcessor for actual processing
   */
  protected async* processSSEStream(
    response: Response,
    options: {
      extractContent: (parsed: any) => string | null;
      extractToolCalls: (parsed: any) => any[] | null;
      extractFinishReason: (parsed: any) => string | null;
      extractUsage?: (parsed: any) => any;
      onParseError?: (error: Error, rawData: string) => void;
      debugLabel?: string;
      // Tool call accumulation settings
      accumulateToolCalls?: boolean;
      toolCallThrottling?: {
        initialYield: boolean;
        progressInterval: number; // Yield every N characters of arguments
      };
    }
  ): AsyncGenerator<StreamChunk, void, unknown> {
    yield* SSEStreamProcessor.processSSEStream(response, options);
  }

  /**
   * Process streaming responses with automatic tool call accumulation
   * Supports both SDK streams (OpenAI, Groq, Mistral) and SSE streams (Requesty, Perplexity, OpenRouter)
   *
   * This unified method handles:
   * - Text content streaming
   * - Tool call accumulation (incremental delta.tool_calls)
   * - Usage/metadata extraction
   * - Finish reason detection
   *
   * Used by: OpenAI, Groq, Mistral, Requesty, Perplexity, OpenRouter
   */
  protected async* processStream(
    stream: AsyncIterable<any> | Response,
    options: {
      extractContent: (chunk: any) => string | null;
      extractToolCalls: (chunk: any) => any[] | null;
      extractFinishReason: (chunk: any) => string | null;
      extractUsage?: (chunk: any) => any;
      // Reasoning/thinking extraction for models that support it
      extractReasoning?: (parsed: any) => { text: string; complete: boolean } | null;
      debugLabel?: string;
    }
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const debugLabel = options.debugLabel || 'Stream';

    // Determine if this is SDK stream or SSE Response
    const isSdkStream = Symbol.iterator in Object(stream) || Symbol.asyncIterator in Object(stream);

    if (isSdkStream) {
      // Process SDK stream (OpenAI SDK, Groq, Mistral)
      const toolCallsAccumulator: Map<number, any> = new Map();
      let usage: any = undefined;

      for await (const chunk of stream as AsyncIterable<any>) {
        yield* this.processStreamChunk(chunk, options, toolCallsAccumulator, usage);

        // Update usage reference if extracted
        if (options.extractUsage) {
          const extractedUsage = options.extractUsage(chunk);
          if (extractedUsage) {
            usage = extractedUsage;
          }
        }
      }

      // Yield final completion with accumulated tool calls
      const finalToolCalls = toolCallsAccumulator.size > 0
        ? Array.from(toolCallsAccumulator.values())
        : undefined;

      const finalUsage = usage ? {
        promptTokens: usage.prompt_tokens || usage.promptTokens || 0,
        completionTokens: usage.completion_tokens || usage.completionTokens || 0,
        totalTokens: usage.total_tokens || usage.totalTokens || 0
      } : undefined;

      yield {
        content: '',
        complete: true,
        usage: finalUsage,
        toolCalls: finalToolCalls,
        toolCallsReady: finalToolCalls && finalToolCalls.length > 0 ? true : undefined
      };
    } else {
      // Process SSE stream (Requesty, Perplexity, OpenRouter via Response object)
      yield* this.processSSEStream(stream as Response, {
        ...options,
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });
    }
  }

  /**
   * Process individual stream chunk with tool call accumulation
   * Delegates to StreamChunkProcessor for actual processing
   */
  private* processStreamChunk(
    chunk: any,
    options: {
      extractContent: (chunk: any) => string | null;
      extractToolCalls: (chunk: any) => any[] | null;
      extractFinishReason: (chunk: any) => string | null;
      extractUsage?: (chunk: any) => any;
    },
    toolCallsAccumulator: Map<number, any>,
    usageRef: any
  ): Generator<StreamChunk, void, unknown> {
    yield* StreamChunkProcessor.processStreamChunk(chunk, options, toolCallsAccumulator, usageRef);
  }

  // Cached generate method
  async generate(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    // Skip cache if explicitly disabled or for streaming
    if (options?.disableCache) {
      return this.generateUncached(prompt, options);
    }

    const cacheKey = this.generateCacheKey(prompt, options);
    
    // Try cache first
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        metadata: {
          ...cached.metadata,
          cached: true,
          cacheHit: true
        }
      };
    }

    // Generate new response
    const response = await this.generateUncached(prompt, options);
    
    // Cache the response
    await this.cache.set(cacheKey, response, options?.cacheTTL);
    
    return {
      ...response,
      metadata: {
        ...response.metadata,
        cached: false,
        cacheHit: false
      }
    };
  }

  // Common implementations
  async generateJSON(prompt: string, schema?: any, options?: GenerateOptions): Promise<any> {
    try {
      const response = await this.generate(prompt, { 
        ...options, 
        jsonMode: true 
      });
      
      const parsed = JSON.parse(response.text);
      
      // Basic schema validation if provided
      if (schema && !this.validateSchema(parsed, schema)) {
        throw new LLMProviderError(
          'Response does not match expected schema',
          this.name,
          'SCHEMA_VALIDATION_ERROR'
        );
      }
      
      return parsed;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new LLMProviderError(
          `Invalid JSON response: ${error.message}`,
          this.name,
          'JSON_PARSE_ERROR',
          error
        );
      }
      throw error;
    }
  }

  // Cache management methods
  protected generateCacheKey(prompt: string, options?: GenerateOptions): string {
    const cacheData = {
      prompt,
      model: options?.model || this.currentModel,
      temperature: options?.temperature || 0.7,
      maxTokens: options?.maxTokens || 2000,
      topP: options?.topP,
      frequencyPenalty: options?.frequencyPenalty,
      presencePenalty: options?.presencePenalty,
      stopSequences: options?.stopSequences,
      systemPrompt: options?.systemPrompt,
      jsonMode: options?.jsonMode
    };

    const serialized = JSON.stringify(cacheData);
    return generateHash(serialized);
  }

  async clearCache(): Promise<void> {
    await this.cache.clear();
  }

  getCacheMetrics() {
    return this.cache.getMetrics();
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }
    
    try {
      await this.listModels();
      return true;
    } catch (error) {
      return false;
    }
  }

  setModel(model: string): void {
    this.currentModel = model;
  }

  getCurrentModel(): string {
    return this.currentModel;
  }

  getApiKey(): string {
    return this.apiKey ? '***' + this.apiKey.slice(-4) : 'NOT_SET';
  }

  // Helper methods
  protected validateConfiguration(): void {
    if (!this.apiKey) {
      throw new LLMProviderError(
        `API key not configured for ${this.name}`,
        this.name,
        'MISSING_API_KEY'
      );
    }
  }

  protected buildHeaders(additionalHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Synaptic-Lab-Kit/1.0.0',
      ...additionalHeaders
    };

    return headers;
  }

  /**
   * Retry operation with exponential backoff
   * Used for handling OpenAI Responses API race conditions (previous_response_not_found)
   * @param operation - Async operation to retry
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   * @param initialDelayMs - Initial delay in milliseconds (default: 50)
   * @returns Result of successful operation
   */
  protected async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    initialDelayMs: number = 50
  ): Promise<T> {
    let lastError: any;
    let delay = initialDelayMs;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        // Only retry on specific "previous_response_not_found" error
        const isPreviousResponseNotFound =
          error?.status === 400 &&
          error?.error?.message?.includes('previous_response_not_found');

        if (!isPreviousResponseNotFound || attempt === maxRetries - 1) {
          throw error;
        }

        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff: 50ms, 100ms, 200ms
      }
    }

    throw lastError;
  }

  protected handleError(error: any, operation: string): never {
    if (error instanceof LLMProviderError) {
      throw error;
    }

    if (error.response) {
      // HTTP error
      const status = error.response.status;
      const message = error.response.data?.error?.message || error.message;
      
      let errorCode = 'HTTP_ERROR';
      if (status === 401) errorCode = 'AUTHENTICATION_ERROR';
      if (status === 403) errorCode = 'PERMISSION_ERROR';
      if (status === 429) errorCode = 'RATE_LIMIT_ERROR';
      if (status >= 500) errorCode = 'SERVER_ERROR';

      throw new LLMProviderError(
        `${operation} failed: ${message}`,
        this.name,
        errorCode,
        error
      );
    }

    throw new LLMProviderError(
      `${operation} failed: ${error.message}`,
      this.name,
      'UNKNOWN_ERROR',
      error
    );
  }

  protected validateSchema(data: any, schema: any): boolean {
    return SchemaValidator.validateSchema(data, schema);
  }

  protected buildMessages(prompt: string, systemPrompt?: string): any[] {
    const messages: any[] = [];
    
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    
    messages.push({ role: 'user', content: prompt });
    
    return messages;
  }

  protected extractUsage(response: any): TokenUsage | undefined {
    return TokenUsageExtractor.extractUsage(response);
  }

  // Cost calculation methods
  protected async calculateCost(usage: TokenUsage, model: string): Promise<CostDetails | null> {
    const modelPricing = await this.getModelPricing(model);
    return LLMCostCalculator.calculateCost(usage, model, modelPricing);
  }

  /**
   * Get caching discount multiplier for a model
   * Delegates to LLMCostCalculator
   */
  protected getCachingDiscount(model: string): number {
    return LLMCostCalculator.getCachingDiscount(model);
  }

  protected async buildLLMResponse(
    content: string,
    model: string,
    usage?: TokenUsage,
    metadata?: Record<string, unknown>,
    finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter',
    toolCalls?: any[]
  ): Promise<LLMResponse> {
    const response: LLMResponse = {
      text: content,
      model,
      provider: this.name,
      usage: usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      metadata: metadata || {},
      finishReason: finishReason || 'stop',
      toolCalls: toolCalls || []
    };

    // Extract webSearchResults from metadata if present
    if (metadata?.webSearchResults && Array.isArray(metadata.webSearchResults)) {
      response.webSearchResults = metadata.webSearchResults as SearchResult[];
    }

    // Calculate cost if usage is available
    if (usage) {
      const cost = await this.calculateCost(usage, model);
      if (cost) {
        response.cost = cost;
      }
    }

    return response;
  }

  // Rate limiting and retry logic
  protected async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
    baseDelay = 1000
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on certain errors
        if (error instanceof LLMProviderError) {
          if (['AUTHENTICATION_ERROR', 'PERMISSION_ERROR', 'MISSING_API_KEY'].includes(error.code || '')) {
            throw error;
          }
        }

        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError!;
  }
}
