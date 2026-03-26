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
  ToolCall,
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
import { BufferedSSEStreamProcessor } from '../streaming/BufferedSSEStreamProcessor';
import { StreamChunkProcessor } from '../streaming/StreamChunkProcessor';
import {
  ProviderHttpClient,
  ProviderHttpError,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderStreamRequest
} from './shared/ProviderHttpClient';

interface StreamUsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  promptTokens?: number;
  promptTokenCount?: number;
  completionTokens?: number;
  totalTokens?: number;
  totalTokenCount?: number;
  candidatesTokenCount?: number;
  input_tokens?: number;
  output_tokens?: number;
  [key: string]: unknown;
}

interface StreamToolCallAccumulator {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
  reasoning_details?: unknown[];
  thought_signature?: string;
  [key: string]: unknown;
}

interface StreamToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  reasoning_details?: unknown[];
  thought_signature?: string;
  [key: string]: unknown;
}

interface StreamParseOptions {
  extractContent: (parsed: unknown) => string | null;
  extractToolCalls: (parsed: unknown) => StreamToolCallDelta[] | null;
  extractFinishReason: (parsed: unknown) => string | null;
  extractUsage?: (parsed: unknown) => StreamUsageLike | null | undefined;
  onParseError?: (error: Error, rawData: string) => void;
  debugLabel?: string;
  accumulateToolCalls?: boolean;
  toolCallThrottling?: {
    initialYield: boolean;
    progressInterval: number;
  };
}

interface BufferedStreamParseOptions extends StreamParseOptions {
  extractMetadata?: (parsed: unknown) => Record<string, unknown> | null;
  extractReasoning?: (parsed: unknown) => { text: string; complete: boolean } | null;
}

interface StreamChunkParseOptions {
  extractContent: (chunk: unknown) => string | null;
  extractToolCalls: (chunk: unknown) => StreamToolCallDelta[] | null;
  extractFinishReason: (chunk: unknown) => string | null;
  extractUsage?: (chunk: unknown) => StreamUsageLike | null | undefined;
  extractReasoning?: (parsed: unknown) => { text: string; complete: boolean } | null;
  debugLabel?: string;
}

interface NodeJsonLineParseOptions {
  extractChunk: (parsed: unknown) => StreamChunk | null;
  extractDone: (parsed: unknown) => boolean;
}

interface BaseChatMessage {
  role: 'system' | 'user';
  content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function getNumericValue(value: unknown): number | undefined {
  return isNumber(value) ? value : undefined;
}

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

  constructor(apiKey: string, defaultModel: string, baseUrl?: string, _requiresApiKey: boolean = true) {
    this.apiKey = apiKey || '';
    this.currentModel = defaultModel;

    this.config = {
      apiKey: this.apiKey,
      baseUrl: baseUrl || ''
    };
  }

  protected initializeCache(cacheConfig?: Record<string, unknown>): void {
    const cacheName = `${this.name}-responses`;
    // getLRUCache creates a new cache if it doesn't exist
    this.cache = CacheManager.getLRUCache<LLMResponse>(cacheName, {
      maxSize: typeof cacheConfig?.maxSize === 'number' ? cacheConfig.maxSize : 1000,
      defaultTTL: typeof cacheConfig?.defaultTTL === 'number' ? cacheConfig.defaultTTL : 3600000, // 1 hour
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
    options: StreamParseOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    yield* SSEStreamProcessor.processSSEStream(response, options);
  }

  protected async* processBufferedSSEText(
    sseText: string,
    options: BufferedStreamParseOptions
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
  ): Promise<AsyncIterable<unknown>> {
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
    nodeStream: AsyncIterable<unknown>,
    options: BufferedStreamParseOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const { createParser } = await import('eventsource-parser');

    const eventQueue: StreamChunk[] = [];
    let isCompleted = false;
    let usage: StreamUsageLike | undefined = undefined;
    let metadata: Record<string, unknown> | undefined = undefined;
    const toolCallsAccumulator: Map<number, StreamToolCallAccumulator> = new Map();

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
        const parsed: unknown = JSON.parse(event.data);

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
              const accumulated: StreamToolCallAccumulator = {
                id: toolCall.id || '',
                type: toolCall.type || 'function',
                function: {
                  name: toolCall.function?.name || '',
                  arguments: toolCall.function?.arguments || ''
                }
              };
              if (toolCall.reasoning_details) accumulated.reasoning_details = toolCall.reasoning_details;
              if (toolCall.thought_signature) accumulated.thought_signature = toolCall.thought_signature;
              toolCallsAccumulator.set(index, accumulated);
              shouldYieldToolCalls = options.toolCallThrottling?.initialYield !== false;
            } else {
              const existing = toolCallsAccumulator.get(index);
              if (!existing) continue;
              if (toolCall.id) existing.id = toolCall.id;
              if (toolCall.function?.name) existing.function.name = toolCall.function.name;
              if (toolCall.function?.arguments) {
                existing.function.arguments += toolCall.function.arguments;
                const interval = options.toolCallThrottling?.progressInterval || 50;
                shouldYieldToolCalls = existing.function.arguments.length > 0 &&
                  existing.function.arguments.length % interval === 0;
              }
              if (toolCall.reasoning_details && !existing.reasoning_details) {
                existing.reasoning_details = toolCall.reasoning_details;
              }
              if (toolCall.thought_signature && !existing.thought_signature) {
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
      } catch (parseError: unknown) {
        if (options.onParseError) {
          options.onParseError(parseError as Error, event.data);
        }
      }
    });

    // Read from the Node.js stream and feed to the SSE parser
    try {
      for await (const chunk of nodeStream) {
        if (isCompleted) break;

        const text = typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk as ArrayBufferLike | Uint8Array).toString('utf-8');
        parser.feed(text);

        // Yield queued events
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          yield event;
          if (event.complete) {
            isCompleted = true;
            break;
          }
        }
      }

      // Yield remaining events after stream ends
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }

      // If stream ended without a completion event, yield one
      if (!isCompleted) {
        yield {
          content: '',
          complete: true,
          usage: this.formatStreamUsage(usage)
        };
      }
    } catch (error: unknown) {
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
    nodeStream: AsyncIterable<unknown>,
    options: NodeJsonLineParseOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    let buffer = '';
    let isCompleted = false;

    try {
      for await (const chunk of nodeStream) {
        if (isCompleted) break;

        buffer += typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk as ArrayBufferLike | Uint8Array).toString('utf-8');

        // Process complete lines
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.substring(0, newlineIdx).trim();
          buffer = buffer.substring(newlineIdx + 1);

          if (!line) continue;

          try {
            const parsed: unknown = JSON.parse(line);
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
    } catch (error: unknown) {
      if (!isCompleted) {
        yield { content: '', complete: true };
      }
      throw error;
    }
  }

  private getFinalToolCallsFromAccumulator(
    accumulator: Map<number, StreamToolCallAccumulator>,
    options: { accumulateToolCalls?: boolean }
  ): ToolCall[] | undefined {
    if (!options.accumulateToolCalls || accumulator.size === 0) return undefined;
    return Array.from(accumulator.values());
  }

  private formatStreamUsage(usage: StreamUsageLike | undefined): StreamChunk['usage'] {
    if (!usage) return undefined;
    return {
      promptTokens:
        getNumericValue(usage.prompt_tokens) ??
        getNumericValue(usage.promptTokens) ??
        getNumericValue(usage.promptTokenCount) ??
        getNumericValue(usage.input_tokens) ??
        0,
      completionTokens:
        getNumericValue(usage.completion_tokens) ??
        getNumericValue(usage.candidatesTokenCount) ??
        getNumericValue(usage.completionTokens) ??
        getNumericValue(usage.output_tokens) ??
        0,
      totalTokens:
        getNumericValue(usage.total_tokens) ??
        getNumericValue(usage.totalTokens) ??
        getNumericValue(usage.totalTokenCount) ??
        0
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
    options: StreamChunkParseOptions
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
        promptTokens: usage.prompt_tokens || usage.promptTokens || usage.promptTokenCount || 0,
        completionTokens: usage.completion_tokens || usage.completionTokens || 0,
        totalTokens: usage.total_tokens || usage.totalTokens || usage.totalTokenCount || 0
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
    options: StreamChunkParseOptions,
    toolCallsAccumulator: Map<number, StreamToolCallAccumulator>,
    usageRef: StreamUsageLike | undefined
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
  async generateJSON(prompt: string, schema?: unknown, options?: GenerateOptions): Promise<unknown> {
    try {
      const response = await this.generate(prompt, { 
        ...options, 
        jsonMode: true 
      });
      
      const parsed: unknown = JSON.parse(response.text);
      
      // Basic schema validation if provided
      if (schema && !this.validateSchema(parsed, schema)) {
        throw new LLMProviderError(
          'Response does not match expected schema',
          this.name,
          'SCHEMA_VALIDATION_ERROR'
        );
      }
      
      return parsed;
    } catch (error: unknown) {
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
    maxRetries: number = 3,
    initialDelayMs: number = 50
  ): Promise<T> {
    let lastError: unknown;
    let delay = initialDelayMs;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        lastError = error;

        // Only retry on specific "previous_response_not_found" error
        const isPreviousResponseNotFound =
          isRecord(error) &&
          error.status === 400 &&
          isRecord(error.error) &&
          typeof error.error.message === 'string' &&
          error.error.message.includes('previous_response_not_found');

        if (!isPreviousResponseNotFound || attempt === maxRetries - 1) {
          throw error;
        }

        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff: 50ms, 100ms, 200ms
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Unknown error');
  }

  protected handleError(error: unknown, operation: string): never {
    if (error instanceof LLMProviderError) {
      throw error;
    }

    if (error instanceof ProviderHttpError) {
      const status = error.response.status;
      const responseData = isRecord(error.response.data) ? error.response.data : null;
      const errorObj = isRecord(responseData?.error) ? responseData.error : undefined;
      const message =
        (typeof errorObj?.message === 'string' ? errorObj.message : undefined) ||
        (typeof responseData?.message === 'string' ? responseData.message : undefined) ||
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

    if (isRecord(error) && isRecord(error.response)) {
      // HTTP error
      const status = typeof error.response.status === 'number' ? error.response.status : 0;
      const responseData = isRecord(error.response.data) ? error.response.data : null;
      const errorData = isRecord(responseData?.error) ? responseData.error : undefined;
      const message =
        (typeof errorData?.message === 'string' ? errorData.message : undefined) ||
        (typeof responseData?.message === 'string' ? responseData.message : undefined) ||
        (typeof error.message === 'string' ? error.message : 'Unknown error');
      
      let errorCode = 'HTTP_ERROR';
      if (status === 401) errorCode = 'AUTHENTICATION_ERROR';
      if (status === 403) errorCode = 'PERMISSION_ERROR';
      if (status === 429) errorCode = 'RATE_LIMIT_ERROR';
      if (status >= 500) errorCode = 'SERVER_ERROR';

      throw new LLMProviderError(
        `${operation} failed: ${message}`,
        this.name,
        errorCode,
        error instanceof Error ? error : undefined
      );
    }

    if (isRecord(error) && typeof error.message === 'string') {
      throw new LLMProviderError(
        `${operation} failed: ${error.message}`,
        this.name,
        'UNKNOWN_ERROR',
        error instanceof Error ? error : undefined
      );
    }

    throw new LLMProviderError(
      `${operation} failed: Unknown error`,
      this.name,
      'UNKNOWN_ERROR',
      undefined
    );
  }

  protected validateSchema(data: unknown, schema: unknown): boolean {
    return SchemaValidator.validateSchema(data, schema);
  }

  protected buildMessages(prompt: string, systemPrompt?: string): BaseChatMessage[] {
    const messages: BaseChatMessage[] = [];
    
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
    if (Array.isArray(metadata?.webSearchResults)) {
      response.webSearchResults = metadata.webSearchResults.filter((result): result is SearchResult => {
        return isRecord(result) &&
          typeof result.title === 'string' &&
          typeof result.url === 'string';
      });
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
