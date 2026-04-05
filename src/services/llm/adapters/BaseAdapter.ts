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
  SearchResult,
  ToolCall
} from './types';
import { BaseCache, CacheManager } from '../utils/CacheManager';
import { LLMCostCalculator } from '../utils/LLMCostCalculator';
import { TokenUsageExtractor } from '../utils/TokenUsageExtractor';
import { SchemaValidator } from '../utils/SchemaValidator';
import { SSEStreamProcessor } from '../streaming/SSEStreamProcessor';
import { BufferedSSEStreamProcessor } from '../streaming/BufferedSSEStreamProcessor';
import { StreamChunkProcessor } from '../streaming/StreamChunkProcessor';
import {
  ProviderHttpClient,
  ProviderHttpError,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderStreamRequest
} from './shared/ProviderHttpClient';
import {
  SSEParsedEvent,
  SSEToolCall,
  SSEParsedUsage,
  SSEStreamOptions
} from '../streaming/SSEStreamProcessor';

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

type JsonObject = Record<string, unknown>;

interface CacheConfig {
  maxSize?: number;
  defaultTTL?: number;
}

type StreamUsageLike = SSEParsedUsage & {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  promptTokenCount?: number;
  completionTokenCount?: number;
  totalTokenCount?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  candidatesTokenCount?: number;
};

interface StreamToolCallAccumulator {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  reasoning_details?: Array<Record<string, unknown>>;
  thought_signature?: string;
}

interface JsonLineParseOptions {
  extractChunk: (parsed: SSEParsedEvent) => StreamChunk | null;
  extractDone: (parsed: SSEParsedEvent) => boolean;
}

interface ChunkParseOptions {
  extractContent: (chunk: Record<string, unknown>) => string | null;
  extractToolCalls: (chunk: Record<string, unknown>) => SSEToolCall[] | null;
  extractFinishReason: (chunk: Record<string, unknown>) => string | null;
  extractUsage?: (chunk: Record<string, unknown>) => StreamUsageLike | undefined;
  extractReasoning?: (parsed: Record<string, unknown>) => { text: string; complete: boolean } | null;
}

export abstract class BaseAdapter {
  abstract readonly name: string;
  abstract readonly baseUrl: string;
  
  protected apiKey: string;
  protected currentModel: string;
  protected config: ProviderConfig;
  protected cache!: BaseCache<LLMResponse>;

  constructor(apiKey: string, defaultModel: string, baseUrl?: string, _requiresApiKey = true) {
    this.apiKey = apiKey || '';
    this.currentModel = defaultModel;

    this.config = {
      apiKey: this.apiKey,
      baseUrl: baseUrl || ''
    };
  }

  protected initializeCache(cacheConfig?: CacheConfig): void {
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
    options: SSEStreamOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    yield* SSEStreamProcessor.processSSEStream(response, options);
  }

  protected async* processBufferedSSEText(
    sseText: string,
    options: SSEStreamOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    yield* BufferedSSEStreamProcessor.processSSEText(sseText, options);
  }

  /**
   * Make a streaming HTTP request via ProviderHttpClient.requestStream().
   * Returns a Node.js ReadableStream that yields chunks as they arrive from the wire.
   * On mobile, falls back to a single-chunk buffered stream.
   */
  protected requestStream(
    config: Omit<ProviderStreamRequest, 'provider'>
  ): Promise<NodeJS.ReadableStream> {
    return ProviderHttpClient.requestStream({
      provider: this.name,
      ...config
    });
  }

  /**
   * Process a Node.js readable stream as SSE, yielding StreamChunks incrementally.
   * Bridges Node.js IncomingMessage → eventsource-parser → adapter SSE options → StreamChunk.
   * This is the real-streaming replacement for processBufferedSSEText.
   */
  protected async* processNodeStream(
    nodeStream: NodeJS.ReadableStream,
    options: SSEStreamOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const { createParser } = await import('eventsource-parser');

    const eventQueue: StreamChunk[] = [];
    let isCompleted = false;
    let usage: SSEParsedUsage | undefined = undefined;
    let metadata: Record<string, unknown> | undefined = undefined;
    const toolCallsAccumulator: Map<number, ToolCall> = new Map();

    const parser = createParser((event) => {
      if (event.type === 'reconnect-interval' || isCompleted) return;

      if (event.data === '[DONE]') {
        const finalToolCalls = this.getFinalToolCallsFromAccumulator(toolCallsAccumulator, options);
        eventQueue.push({
          content: '',
          complete: true,
          usage: this.formatStreamUsage(usage),
          toolCalls: finalToolCalls,
          toolCallsReady: finalToolCalls && finalToolCalls.length > 0 ? true : undefined,
          metadata
        });
        isCompleted = true;
        return;
      }

      try {
        const parsed = JSON.parse(event.data) as SSEParsedEvent;

        if (options.extractMetadata) {
          metadata = { ...(metadata || {}), ...(options.extractMetadata(parsed) || {}) };
        }

        const content = options.extractContent(parsed);
        if (content) {
          eventQueue.push({ content, complete: false });
        }

        if (options.extractReasoning) {
          const reasoning = options.extractReasoning(parsed);
          if (reasoning) {
            eventQueue.push({
              content: '',
              complete: false,
              reasoning: reasoning.text,
              reasoningComplete: reasoning.complete
            });
          }
        }

        const toolCalls = options.extractToolCalls(parsed);
        if (toolCalls && options.accumulateToolCalls) {
          let shouldYieldToolCalls = false;
          for (const toolCall of toolCalls) {
            const index = toolCall.index || 0;
            if (!toolCallsAccumulator.has(index)) {
              const accumulated: ToolCall = {
                id: toolCall.id || '',
                type: 'function',
                function: {
                  name: toolCall.function?.name || '',
                  arguments: toolCall.function?.arguments || ''
                }
              };
              if (Array.isArray(toolCall.reasoning_details)) {
                accumulated.reasoning_details = toolCall.reasoning_details;
              }
              if (typeof toolCall.thought_signature === 'string') {
                accumulated.thought_signature = toolCall.thought_signature;
              }
              toolCallsAccumulator.set(index, accumulated);
              shouldYieldToolCalls = options.toolCallThrottling?.initialYield !== false;
            } else {
              const existing = toolCallsAccumulator.get(index);
              if (!existing) {
                continue;
              }
              if (toolCall.id) existing.id = toolCall.id;
              if (toolCall.function?.name) existing.function.name = toolCall.function.name;
              if (toolCall.function?.arguments) {
                existing.function.arguments += toolCall.function.arguments;
                const interval = options.toolCallThrottling?.progressInterval || 50;
                shouldYieldToolCalls = existing.function.arguments.length > 0 &&
                  existing.function.arguments.length % interval === 0;
              }
              if (Array.isArray(toolCall.reasoning_details) && !existing.reasoning_details) {
                existing.reasoning_details = toolCall.reasoning_details;
              }
              if (typeof toolCall.thought_signature === 'string' && !existing.thought_signature) {
                existing.thought_signature = toolCall.thought_signature;
              }
            }
          }
          if (shouldYieldToolCalls) {
            eventQueue.push({
              content: '',
              complete: false,
              toolCalls: Array.from(toolCallsAccumulator.values())
            });
          }
        }

        if (options.extractUsage) {
          const extractedUsage = options.extractUsage(parsed);
          if (extractedUsage) usage = extractedUsage;
        }

        const finishReason = options.extractFinishReason(parsed);
        if (finishReason === 'stop' || finishReason === 'length' || finishReason === 'tool_calls') {
          const finalToolCalls = this.getFinalToolCallsFromAccumulator(toolCallsAccumulator, options);
          eventQueue.push({
            content: '',
            complete: true,
            usage: this.formatStreamUsage(usage),
            toolCalls: finalToolCalls,
            toolCallsReady: finalToolCalls && finalToolCalls.length > 0 ? true : undefined,
            metadata
          });
          isCompleted = true;
        }
      } catch (parseError) {
        if (options.onParseError) {
          options.onParseError(parseError as Error, event.data);
        }
      }
    });

    // Read from the Node.js stream and feed to the SSE parser
    try {
      for await (const chunk of nodeStream as AsyncIterable<Buffer>) {
        if (isCompleted) break;

        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        parser.feed(text);

        // Yield queued events
        while (eventQueue.length > 0) {
          const event = eventQueue.shift();
          if (!event) {
            break;
          }
          yield event;
          if (event.complete) {
            isCompleted = true;
            break;
          }
        }
      }

      // Yield remaining events after stream ends
      while (eventQueue.length > 0) {
        const event = eventQueue.shift();
        if (event) {
          yield event;
        }
      }

      // If stream ended without a completion event, yield one
      if (!isCompleted) {
        yield {
          content: '',
          complete: true,
          usage: this.formatStreamUsage(usage)
        };
      }
    } catch (error) {
      // If stream was destroyed (abort), yield completion
      if (!isCompleted) {
        yield { content: '', complete: true };
      }
      throw error;
    }
  }

  /**
   * Process a Node.js readable stream as newline-delimited JSON (NDJSON).
   * Used by Ollama which returns one JSON object per line instead of SSE.
   */
  protected async* processNodeStreamJsonLines(
    nodeStream: NodeJS.ReadableStream,
    options: JsonLineParseOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    let buffer = '';
    let isCompleted = false;

    try {
      for await (const chunk of nodeStream as AsyncIterable<Buffer>) {
        if (isCompleted) break;

        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');

        // Process complete lines
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.substring(0, newlineIdx).trim();
          buffer = buffer.substring(newlineIdx + 1);

          if (!line) continue;

          try {
            const parsed = JSON.parse(line) as SSEParsedEvent;
            if (options.extractDone(parsed)) {
              isCompleted = true;
              const streamChunk = options.extractChunk(parsed);
              if (streamChunk) yield streamChunk;
              yield { content: '', complete: true };
              break;
            }
            const streamChunk = options.extractChunk(parsed);
            if (streamChunk) yield streamChunk;
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      if (!isCompleted) {
        yield { content: '', complete: true };
      }
    } catch (error) {
      if (!isCompleted) {
        yield { content: '', complete: true };
      }
      throw error;
    }
  }

  private getFinalToolCallsFromAccumulator(
    accumulator: Map<number, ToolCall>,
    options: SSEStreamOptions
  ): ToolCall[] | undefined {
    if (!options.accumulateToolCalls || accumulator.size === 0) return undefined;
    return Array.from(accumulator.values());
  }

  private formatStreamUsage(usage: StreamUsageLike | undefined): StreamChunk['usage'] {
    if (!usage) return undefined;
    return {
      promptTokens: usage.prompt_tokens || usage.promptTokenCount || usage.promptTokens || usage.input_tokens || 0,
      completionTokens: usage.completion_tokens || usage.completionTokenCount || usage.completionTokens || usage.output_tokens || 0,
      totalTokens: usage.total_tokens || usage.totalTokenCount || usage.totalTokens || 0
    };
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
    stream: AsyncIterable<unknown> | Response,
    options: ChunkParseOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    // Determine if this is SDK stream or SSE Response
    const isSdkStream = Symbol.iterator in Object(stream) || Symbol.asyncIterator in Object(stream);

    if (isSdkStream) {
      // Process SDK stream (OpenAI SDK, Groq, Mistral)
      const toolCallsAccumulator: Map<number, StreamToolCallAccumulator> = new Map();
      let usage: StreamUsageLike | undefined = undefined;

      for await (const chunk of stream as AsyncIterable<unknown>) {
        yield* this.processStreamChunk(chunk, options, toolCallsAccumulator, usage);

        // Update usage reference if extracted
        if (options.extractUsage) {
          const extractedUsage = options.extractUsage(chunk as Record<string, unknown>);
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
    chunk: unknown,
    options: ChunkParseOptions,
    toolCallsAccumulator: Map<number, StreamToolCallAccumulator>,
    usageRef: StreamUsageLike | undefined
  ): Generator<StreamChunk, void, unknown> {
    yield* StreamChunkProcessor.processStreamChunk(
      chunk as Record<string, unknown>,
      options,
      toolCallsAccumulator,
      usageRef
    );
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
  async generateJSON(prompt: string, schema?: JsonObject, options?: GenerateOptions): Promise<unknown> {
    try {
      const response = await this.generate(prompt, { 
        ...options, 
        jsonMode: true 
      });
      
      const parsed = JSON.parse(response.text) as unknown;
      
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

  getCacheMetrics(): ReturnType<BaseCache<LLMResponse>['getMetrics']> {
    return this.cache.getMetrics();
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }
    
    try {
      await this.listModels();
      return true;
    } catch {
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

  protected async request<TJson = unknown>(
    config: Omit<ProviderHttpRequest, 'provider'>
  ): Promise<ProviderHttpResponse<TJson>> {
    return ProviderHttpClient.request<TJson>({
      provider: this.name,
      ...config
    });
  }

  protected assertOk<TJson = unknown>(
    response: ProviderHttpResponse<TJson>,
    message?: string
  ): ProviderHttpResponse<TJson> {
    return ProviderHttpClient.assertOk(response, message);
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
    maxRetries = 3,
    initialDelayMs = 50
  ): Promise<T> {
    let lastError: unknown;
    let delay = initialDelayMs;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        lastError = error;

        // Only retry on specific "previous_response_not_found" error
        const retryError = error as {
          status?: number;
          error?: { message?: string };
        };
        const isPreviousResponseNotFound =
          retryError.status === 400 &&
          retryError.error?.message?.includes('previous_response_not_found');

        if (!isPreviousResponseNotFound || attempt === maxRetries - 1) {
          throw error;
        }

        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff: 50ms, 100ms, 200ms
      }
    }

    throw lastError;
  }

  protected handleError(error: unknown, operation: string): never {
    if (error instanceof LLMProviderError) {
      throw error;
    }

    if (error instanceof ProviderHttpError) {
      const status = error.response.status;
      const responseData = error.response.data as Record<string, unknown> | null;
      const errorObj = responseData?.error as Record<string, unknown> | undefined;
      const message =
        (errorObj?.message as string) ||
        (responseData?.message as string) ||
        error.response.text ||
        error.message;

      let errorCode = 'HTTP_ERROR';
      if (status === 400) errorCode = 'INVALID_REQUEST';
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

    if (typeof error === 'object' && error !== null && 'response' in error) {
      const responseError = error as {
        response: {
          status: number;
          data?: {
            error?: { message?: string };
            message?: string;
          } | null;
          text?: string;
        };
        message?: string;
      };
      // HTTP error
      const status = responseError.response.status;
      const message = responseError.response.data?.error?.message || responseError.message || responseError.response.text;
      
      let errorCode = 'HTTP_ERROR';
      if (status === 401) errorCode = 'AUTHENTICATION_ERROR';
      if (status === 403) errorCode = 'PERMISSION_ERROR';
      if (status === 429) errorCode = 'RATE_LIMIT_ERROR';
      if (status >= 500) errorCode = 'SERVER_ERROR';

      const normalizedError = error instanceof Error ? error : new Error(message || operation);
      throw new LLMProviderError(
        `${operation} failed: ${message}`,
        this.name,
        errorCode,
        normalizedError
      );
    }

    const fallbackMessage = error instanceof Error ? error.message : String(error);
    const normalizedError = error instanceof Error ? error : new Error(fallbackMessage);
    throw new LLMProviderError(
      `${operation} failed: ${fallbackMessage}`,
      this.name,
      'UNKNOWN_ERROR',
      normalizedError
    );
  }

  protected validateSchema(data: unknown, schema: JsonObject): boolean {
    return SchemaValidator.validateSchema(data, schema);
  }

  protected buildMessages(prompt: string, systemPrompt?: string): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    
    messages.push({ role: 'user', content: prompt });
    
    return messages;
  }

  protected extractUsage(response: unknown): TokenUsage | undefined {
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
    toolCalls?: ToolCall[]
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
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
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
    
    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error('Retry failed without an Error instance');
  }
}
