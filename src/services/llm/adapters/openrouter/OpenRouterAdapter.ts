/**
 * OpenRouter Adapter - Clean implementation with centralized SSE streaming
 * Supports 400+ models through OpenRouter's unified API
 * Uses BaseAdapter's processSSEStream for reliable streaming
 */

import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  TokenUsage,
  CostDetails,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  ToolCall,
  SearchResult
} from '../types';
import { ModelRegistry } from '../ModelRegistry';
import type { ModelSpec } from '../modelTypes';
import { ReasoningPreserver } from '../shared/ReasoningPreserver';
import { WebSearchUtils } from '../../utils/WebSearchUtils';
import { BRAND_NAME } from '../../../../constants/branding';
import { MCPToolExecution } from '../shared/ToolExecutionUtils';

interface OpenRouterExtraContent {
  google?: {
    thought_signature?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OpenRouterToolCallLike {
  id?: string;
  index?: number;
  type?: string;
  name?: string;
  function?: {
    name?: string;
    arguments?: string;
    [key: string]: unknown;
  };
  parameters?: Record<string, unknown>;
  reasoning_details?: unknown[];
  thought_signature?: string;
  thoughtSignature?: string;
  extra_content?: OpenRouterExtraContent;
  [key: string]: unknown;
}

interface OpenRouterChoiceLike {
  delta?: OpenRouterToolCallLike & {
    content?: string;
    text?: string;
    tool_calls?: OpenRouterToolCallLike[];
    toolCalls?: OpenRouterToolCallLike[];
  };
  message?: OpenRouterToolCallLike & {
    content?: string;
    text?: string;
    tool_calls?: OpenRouterToolCallLike[];
    toolCalls?: OpenRouterToolCallLike[];
  };
  text?: string;
  finish_reason?: string;
  thought_signature?: string;
  thoughtSignature?: string;
  [key: string]: unknown;
}

interface OpenRouterChatResponse {
  id?: string;
  choices?: OpenRouterChoiceLike[];
  reasoning_details?: unknown[];
  extra_content?: OpenRouterExtraContent;
  thought_signature?: string;
  thoughtSignature?: string;
  usage?: unknown;
  [key: string]: unknown;
}

interface OpenRouterGenerationStatsResponse {
  data?: {
    native_tokens_prompt?: number;
    tokens_prompt?: number;
    native_tokens_completion?: number;
    tokens_completion?: number;
    total_cost?: number;
    currency?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OpenRouterAnnotation {
  type?: string;
  url_citation?: {
    title?: string;
    text?: string;
    url?: string;
    date?: string;
    timestamp?: string;
  };
  [key: string]: unknown;
}

interface OpenRouterAnnotatedResponse {
  choices?: Array<{
    message?: {
      annotations?: OpenRouterAnnotation[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

interface OpenRouterToolResultLike {
  id: string;
  name?: string;
  success: boolean;
  result?: unknown;
  error?: string;
  executionTime?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOpenRouterToolCallArray(value: unknown): value is OpenRouterToolCallLike[] {
  return Array.isArray(value);
}

function getToolCallArray(source: unknown): OpenRouterToolCallLike[] | undefined {
  if (!isRecord(source)) {
    return undefined;
  }

  const toolCalls = source.tool_calls ?? source.toolCalls;
  return isOpenRouterToolCallArray(toolCalls) ? toolCalls : undefined;
}

function getReasoningDetails(source: unknown): unknown[] | undefined {
  if (!isRecord(source)) {
    return undefined;
  }

  const reasoningDetails = source.reasoning_details;
  if (!Array.isArray(reasoningDetails)) {
    return undefined;
  }

  const result: unknown[] = [];
  for (const entry of reasoningDetails) {
    result.push(entry);
  }

  return result;
}

function getThoughtSignature(source: unknown): string | undefined {
  if (!isRecord(source)) {
    return undefined;
  }

  const extraContent = isRecord(source.extra_content) ? source.extra_content : undefined;
  const google = extraContent && isRecord(extraContent.google) ? extraContent.google : undefined;

  if (google && typeof google.thought_signature === 'string') {
    return google.thought_signature;
  }

  if (typeof source.thought_signature === 'string') {
    return source.thought_signature;
  }

  if (typeof source.thoughtSignature === 'string') {
    return source.thoughtSignature;
  }

  return undefined;
}

function getChoices(response: unknown): OpenRouterChoiceLike[] {
  if (!isRecord(response) || !Array.isArray(response.choices)) {
    return [];
  }

  const choices = response.choices as unknown[];
  const result: OpenRouterChoiceLike[] = [];
  for (const choice of choices) {
    if (isRecord(choice)) {
      result.push(choice);
    }
  }

  return result;
}

function normalizeStreamChunkChunk(chunk: unknown): OpenRouterChatResponse | null {
  return isRecord(chunk) ? chunk : null;
}

export class OpenRouterAdapter extends BaseAdapter {
  readonly name = 'openrouter';
  readonly baseUrl = 'https://openrouter.ai/api/v1';

  private httpReferer: string;
  private xTitle: string;

  constructor(
    apiKey: string,
    options?: { httpReferer?: string; xTitle?: string }
  ) {
    super(apiKey, 'anthropic/claude-3.5-sonnet');
    this.httpReferer = options?.httpReferer?.trim() || 'https://synapticlabs.ai';
    this.xTitle = options?.xTitle?.trim() || BRAND_NAME;
    this.initializeCache();
  }

  /**
   * Generate response without caching
   */
  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    try {
      // Validate web search support
      if (options?.webSearch) {
        WebSearchUtils.validateWebSearchRequest('openrouter', options.webSearch);
      }

      const baseModel = options?.model || this.currentModel;

      // Add :online suffix for web search
      const model = options?.webSearch ? `${baseModel}:online` : baseModel;

      // Handle post-stream tool execution: if detectedToolCalls are provided, execute only tools
      if (options?.detectedToolCalls && options.detectedToolCalls.length > 0) {
        return await this.executeDetectedToolCalls(options.detectedToolCalls, model, prompt, options);
      }

      // Tool execution requires streaming - use generateStreamAsync instead
      if (options?.tools && options.tools.length > 0) {
        throw new Error('Tool execution requires streaming. Use generateStreamAsync() instead.');
      }

      const requestBody = {
        model,
        messages: this.buildMessages(prompt, options?.systemPrompt),
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
        stop: options?.stopSequences,
        tools: options?.tools ? this.convertTools(options.tools) : undefined,
        usage: { include: true } // Enable token usage and cost tracking
      };

      const response = await this.request<OpenRouterChatResponse>({
        url: `${this.baseUrl}/chat/completions`,
        operation: 'generation',
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': this.httpReferer,
          'X-Title': this.xTitle
        },
        body: JSON.stringify(requestBody),
        timeoutMs: 60_000
      });

      this.assertOk(response, `OpenRouter generation failed: HTTP ${response.status}`);

      const data = response.json;
      if (!data) {
        throw new Error('OpenRouter generation returned no JSON payload');
      }

      const text = data.choices[0]?.message?.content || '';
      const usage = this.extractUsage(data);
      const finishReason = data.choices[0]?.finish_reason || 'stop';

      // Extract web search results if web search was enabled
      const webSearchResults = options?.webSearch
        ? this.extractOpenRouterSources(data)
        : undefined;

      return this.buildLLMResponse(
        text,
        baseModel, // Use base model name, not :online version
        usage,
        { webSearchResults },
        finishReason as 'stop' | 'length' | 'tool_calls' | 'content_filter'
      );
    } catch (error) {
      this.handleError(error, 'generation');
    }
  }

  /**
   * Generate streaming response using unified stream processing
   * Uses processStream which automatically handles SSE parsing and tool call accumulation
   */
  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      // Validate web search support
      if (options?.webSearch) {
        WebSearchUtils.validateWebSearchRequest('openrouter', options.webSearch);
      }

      const baseModel = options?.model || this.currentModel;

      // Add :online suffix for web search
      const model = options?.webSearch ? `${baseModel}:online` : baseModel;

      const messages = options?.conversationHistory || this.buildMessages(prompt, options?.systemPrompt);

      // Check if this model requires reasoning preservation (Gemini via OpenRouter)
      const needsReasoning = ReasoningPreserver.requiresReasoningPreservation(baseModel, 'openrouter');
      const hasTools = options?.tools && options.tools.length > 0;

      const requestBody: Record<string, unknown> = {
        model,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
        stop: options?.stopSequences,
        tools: options?.tools ? this.convertTools(options.tools) : undefined,
        stream: true,
        // Enable reasoning for Gemini models to capture thought signatures
        ...ReasoningPreserver.getReasoningRequestParams(baseModel, 'openrouter', hasTools || false)
      };

      const nodeStream = await this.requestStream({
        url: `${this.baseUrl}/chat/completions`,
        operation: 'streaming generation',
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': this.httpReferer,
          'X-Title': this.xTitle
        },
        body: JSON.stringify(requestBody),
        timeoutMs: 120_000
      });

      // Track generation ID for async usage retrieval
      let generationId: string | null = null;
      let usageFetchTriggered = false;
      // Track reasoning data for models that need preservation (Gemini via OpenRouter)
      // Gemini requires TWO different fields for tool continuations:
      // - reasoning_details: array of reasoning objects from OpenRouter
      // - thought_signature: string signature required by Google for function call continuations
      let capturedReasoning: unknown[] | undefined = undefined;
      let capturedThoughtSignature: string | undefined = undefined;

      yield* this.processNodeStream(nodeStream, {
        debugLabel: 'OpenRouter',

        extractContent: (parsed: unknown) => {
          const chunk = normalizeStreamChunkChunk(parsed);
          if (!chunk) {
            return null;
          }

          // Capture generation ID from first chunk
          if (!generationId && typeof chunk.id === 'string') {
            generationId = chunk.id;
          }

          // Capture reasoning_details for Gemini models (required for tool continuations)
          if (needsReasoning && !capturedReasoning) {
            capturedReasoning =
              getReasoningDetails(chunk) ||
              getReasoningDetails(chunk.choices?.[0]?.message) ||
              getReasoningDetails(chunk.choices?.[0]?.delta) ||
              getReasoningDetails(chunk.choices?.[0]) ||
              ReasoningPreserver.extractFromStreamChunk(chunk);
          }

          // Capture thought_signature for Gemini models (OpenAI compatibility format)
          // Per Google docs, this can be in: extra_content.google.thought_signature
          // or directly on the delta/message
          if (needsReasoning && !capturedThoughtSignature) {
            const firstChoice = chunk.choices?.[0];
            const delta = firstChoice?.delta;
            const message = firstChoice?.message;

            capturedThoughtSignature =
              // OpenAI compatibility format per Google docs
              getThoughtSignature(delta) ||
              getThoughtSignature(message) ||
              getThoughtSignature(chunk) ||
              // Direct formats
              undefined;
          }

          // Process all available choices - reasoning models may use multiple choices
          for (const choice of getChoices(chunk)) {
            const delta = choice?.delta;
            const content = delta?.content || delta?.text || choice?.text;
            if (content) {
              return content;
            }
          }
          return null;
        },

        extractToolCalls: (parsed: unknown) => {
          const chunk = normalizeStreamChunkChunk(parsed);
          if (!chunk) {
            return null;
          }

          // Extract tool calls from any choice that has them
          for (const choice of getChoices(chunk)) {
            let toolCalls = getToolCallArray(choice.delta);
            if (toolCalls) {
              // Extract reasoning_details from this chunk (it may contain encrypted thought signatures)
              const chunkReasoningDetails = getReasoningDetails(choice.delta);
              if (chunkReasoningDetails) {
                // Look for reasoning.encrypted entries - these contain the thought_signature
                for (const entry of chunkReasoningDetails) {
                  if (isRecord(entry) && entry.type === 'reasoning.encrypted' && typeof entry.data === 'string' && typeof entry.id === 'string') {
                    // Match encrypted entry to tool call by id
                    for (const tc of toolCalls) {
                      if (typeof tc.id === 'string' && (tc.id === entry.id || tc.id.startsWith(entry.id.split('_').slice(0, -1).join('_')))) {
                        tc.thought_signature = entry.data;
                      }
                    }
                    // Also store as fallback
                    if (!capturedThoughtSignature) {
                      capturedThoughtSignature = entry.data;
                    }
                  }
                }
                // Update capturedReasoning to include all entries (both text and encrypted)
                if (!capturedReasoning) {
                  capturedReasoning = chunkReasoningDetails;
                } else if (Array.isArray(capturedReasoning)) {
                  // Merge in new entries
                  capturedReasoning = [...capturedReasoning, ...chunkReasoningDetails];
                }
              }

              // Also check direct thought_signature fields (fallback)
              for (const tc of toolCalls) {
                const tcThoughtSig = getThoughtSignature(tc);
                if (tcThoughtSig && !tc.thought_signature) {
                  tc.thought_signature = tcThoughtSig;
                }
              }

              // Attach reasoning data (both reasoning_details AND thought_signature)
              const hasReasoning = capturedReasoning || capturedThoughtSignature;
              if (hasReasoning) {
                toolCalls = ReasoningPreserver.attachToToolCalls(
                  toolCalls,
                  {
                    reasoning_details: capturedReasoning,
                    thought_signature: capturedThoughtSignature
                  }
                );
              }
              return toolCalls;
            }
          }
          return null;
        },

        extractFinishReason: (parsed: unknown) => {
          const chunk = normalizeStreamChunkChunk(parsed);
          if (!chunk) {
            return null;
          }

          // Extract finish reason from any choice
          for (const choice of getChoices(chunk)) {
            if (choice?.finish_reason) {
              // Last chance to capture thought_signature from final chunk
              if (needsReasoning && !capturedThoughtSignature) {
                capturedThoughtSignature =
                  getThoughtSignature(choice.delta) ||
                  getThoughtSignature(choice.message) ||
                  getThoughtSignature(chunk) ||
                  getThoughtSignature(choice);
              }

              // When we detect completion, trigger async usage fetch (only once)
              if (generationId && options?.onUsageAvailable && !usageFetchTriggered) {
                usageFetchTriggered = true;
                // Fire and forget - don't await
                this.fetchAndNotifyUsage(generationId, baseModel, options.onUsageAvailable).catch(() => undefined);
              }

              return choice.finish_reason;
            }
          }
          return null;
        },

        extractUsage: (_parsed: unknown) => {
          // OpenRouter doesn't include usage in streaming responses
          // We'll fetch it asynchronously using the generation ID when completion is detected
          return null;
        },

        // Extract reasoning from reasoning_details array (OpenRouter unified format)
        extractReasoning: (parsed: unknown) => {
          const chunk = normalizeStreamChunkChunk(parsed);
          if (!chunk) {
            return null;
          }

          // Check for reasoning_details in delta or message
          const firstChoice = chunk.choices?.[0];
          const reasoningDetails =
            getReasoningDetails(firstChoice?.delta) ||
            getReasoningDetails(firstChoice?.message) ||
            getReasoningDetails(chunk);

          if (reasoningDetails) {
            // Find reasoning.text entries (these contain the actual reasoning text)
            const textEntries = reasoningDetails.filter((r): r is { type?: string; text?: string } & Record<string, unknown> => isRecord(r) && r.type === 'reasoning.text');
            if (textEntries.length > 0) {
              const reasoningText = textEntries.map((r) => r.text || '').join('');
              if (reasoningText) {
                return {
                  text: reasoningText,
                  complete: false  // We can't know if reasoning is complete from streaming
                };
              }
            }

            // Also check for reasoning.summary entries
            const summaryEntries = reasoningDetails.filter((r): r is { type?: string; text?: string; summary?: string } & Record<string, unknown> => isRecord(r) && r.type === 'reasoning.summary');
            if (summaryEntries.length > 0) {
              const summaryText = summaryEntries.map((r) => r.text || r.summary || '').join('');
              if (summaryText) {
                return {
                  text: summaryText,
                  complete: false
                };
              }
            }
          }
          return null;
        },
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });

    } catch (error) {
      this.handleError(error, 'streaming generation');
    }
  }

  /**
   * Fetch usage data and notify via callback - runs asynchronously after streaming completes
   */
  private async fetchAndNotifyUsage(
    generationId: string,
    model: string,
    onUsageAvailable: (usage: TokenUsage, cost?: CostDetails) => void
  ): Promise<void> {
    const stats = await this.fetchGenerationStats(generationId);

    if (!stats) {
      return;
    }

    const usage: TokenUsage = {
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
      totalTokens: stats.totalTokens
    };

    // Calculate cost - prefer provider total_cost when present, otherwise fall back to pricing calculation
    let cost: CostDetails | null;
    if (stats.totalCost !== undefined) {
      const calculatedCost = await this.calculateCost(usage, model);
      cost = calculatedCost
        ? {
            ...calculatedCost,
            totalCost: stats.totalCost,
            currency: stats.currency || calculatedCost.currency
          }
        : null;
    } else {
      cost = await this.calculateCost(usage, model);
    }

    // Notify via callback
    onUsageAvailable(usage, cost || undefined);
  }

  /**
   * Fetch generation statistics from OpenRouter using generation ID with exponential backoff
   * This is the proper way to get token usage and cost for streaming requests
   */
  private async fetchGenerationStats(generationId: string): Promise<{
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    totalCost?: number;
    currency?: string;
  } | null> {
    // OpenRouter stats can lag ~3-6s; extend retries to reduce 404 noise
    const maxRetries = 12;
    const baseDelay = 900; // Start near 1s
    const incrementDelay = 500; // Grow more aggressively
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Linear backoff: 800ms, 1000ms, 1200ms, 1400ms, 1600ms
        if (attempt > 0) {
          const delay = baseDelay + (incrementDelay * attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        const response = await this.request<OpenRouterGenerationStatsResponse>({
          url: `${this.baseUrl}/generation?id=${generationId}`,
          operation: 'fetch generation stats',
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'HTTP-Referer': this.httpReferer,
            'X-Title': this.xTitle
          },
          timeoutMs: 30_000
        });

        if (response.status === 404) {
          // Stats not ready yet, retry
          continue;
        }

        if (!response.ok) {
          return null;
        }

        const data = response.json;
        if (!data) {
          continue;
        }

        // Extract token counts from response
        // OpenRouter returns: tokens_prompt, tokens_completion, native_tokens_prompt, native_tokens_completion
        const promptTokens = data.data?.native_tokens_prompt || data.data?.tokens_prompt || 0;
        const completionTokens = data.data?.native_tokens_completion || data.data?.tokens_completion || 0;
        const totalCost = data.data?.total_cost ?? undefined;
        const currency = 'USD';

        if (promptTokens > 0 || completionTokens > 0) {
          return {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            totalCost,
            currency
          };
        }

        // Data returned but no tokens - might not be ready yet
      } catch {
        if (attempt === maxRetries - 1) {
          return null;
        }
      }
    }

    return null;
  }

  /**
   * List available models
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      // Use centralized model registry
      const openrouterModels = ModelRegistry.getProviderModels('openrouter');
      return openrouterModels.map((model: ModelSpec): ModelInfo => ({
        id: model.apiName,
        name: model.name,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        supportsJSON: model.capabilities.supportsJSON,
        supportsImages: model.capabilities.supportsImages,
        supportsFunctions: model.capabilities.supportsFunctions,
        supportsStreaming: model.capabilities.supportsStreaming,
        supportsThinking: model.capabilities.supportsThinking,
        pricing: {
          inputPerMillion: model.inputCostPerMillion,
          outputPerMillion: model.outputCostPerMillion,
          currency: 'USD',
          lastUpdated: new Date().toISOString()
        }
      }));
    } catch {
      this.handleError(new Error('Failed to list models'), 'listing models');
      return [];
    }
  }

  /**
   * Get provider capabilities
   */
  getCapabilities(): ProviderCapabilities {
    const baseCapabilities = {
      supportsStreaming: true,
      streamingMode: 'streaming' as const,
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: false,
      maxContextWindow: 2000000, // Varies by model
      supportedFeatures: [
        'streaming',
        'json_mode',
        'function_calling',
        'image_input',
        '400+ models'
      ]
    };

    return baseCapabilities;
  }

  /**
   * Execute detected tool calls from streaming and get AI response
   * Used for post-stream tool execution - implements pingpong pattern
   */
  private async executeDetectedToolCalls(detectedToolCalls: ReadonlyArray<ToolCall>, model: string, prompt: string, options?: GenerateOptions): Promise<LLMResponse> {

    try {
      // Convert to MCP format
      const mcpToolCalls = detectedToolCalls.map((tc) => ({
        id: tc.id,
        function: {
          name: tc.function?.name || tc.name,
          arguments: tc.function?.arguments || JSON.stringify(tc.parameters || {})
        }
      }));

      // Execute tool calls directly using MCPToolExecution
      // Note: This path is deprecated - tool execution now happens in StreamingOrchestrator
      // Passing null will return error results for all tools
      const toolResults = await MCPToolExecution.executeToolCalls(
        null, // No toolExecutor available in adapter context
        mcpToolCalls,
        'openrouter',
        options?.onToolEvent
      ) as OpenRouterToolResultLike[];


      // Now do the "pingpong" - send the conversation with tool results back to the LLM
      const messages = this.buildMessages(prompt, options?.systemPrompt);

      // Build assistant message with reasoning preserved using centralized utility
      const assistantMessage = ReasoningPreserver.buildAssistantMessageWithReasoning(
        detectedToolCalls,
        '' // Empty content since this was a tool call
      );

      messages.push(assistantMessage);

      // Add tool result messages
      const toolMessages = MCPToolExecution.buildToolMessages(toolResults, 'openrouter') as Array<{
        role: 'tool';
        tool_call_id: string;
        content: string;
      }>;
      messages.push(...toolMessages);


      // Make API call to get AI's response to the tool results
      const requestBody = {
        model,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
        stop: options?.stopSequences,
        usage: { include: true } // Enable token usage and cost tracking
      };
      
      const response = await this.request<OpenRouterChatResponse>({
        url: `${this.baseUrl}/chat/completions`,
        operation: 'post-stream tool execution',
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': this.httpReferer,
          'X-Title': this.xTitle
        },
        body: JSON.stringify(requestBody),
        timeoutMs: 60_000
      });

      this.assertOk(response, `OpenRouter tool execution failed: HTTP ${response.status}`);

      const data = response.json;
      if (!data) {
        throw new Error('OpenRouter tool execution returned no JSON payload');
      }

      const choice = data.choices?.[0];
      const finalContent = choice?.message?.content || 'No response from AI after tool execution';
      const usage = this.extractUsage(data);


      // Combine original tool calls with their execution results
      const completeToolCalls: ToolCall[] = detectedToolCalls.map(originalCall => {
        const result = toolResults.find((toolResult): toolResult is OpenRouterToolResultLike => toolResult.id === originalCall.id);
        const parameters = JSON.parse(originalCall.function.arguments || '{}') as Record<string, unknown>;
        return {
          id: originalCall.id,
          name: originalCall.name,
          function: {
            name: originalCall.function.name,
            arguments: originalCall.function.arguments
          },
          parameters,
          result: result?.result,
          success: result?.success || false,
          error: result?.error,
          executionTime: result?.executionTime
        };
      });

      // Return LLMResponse with AI's natural language response to tool results
      return this.buildLLMResponse(
        finalContent,
        model,
        usage,
        MCPToolExecution.buildToolMetadata(toolResults),
        choice?.finish_reason || 'stop',
        completeToolCalls
      );

    } catch (error) {
      console.error('OpenRouter adapter post-stream tool execution failed:', error);
      this.handleError(error, 'post-stream tool execution');
    }
  }

  /**
   * Extract search results from OpenRouter response annotations
   */
  private extractOpenRouterSources(response: OpenRouterAnnotatedResponse): SearchResult[] {
    try {
      const annotations: OpenRouterAnnotation[] = response.choices?.[0]?.message?.annotations ?? [];
      const sources: SearchResult[] = [];

      for (const annotation of annotations) {
        if (annotation.type !== 'url_citation') {
          continue;
        }

        const citation = annotation.url_citation;
        const result = WebSearchUtils.validateSearchResult({
          title: citation?.title || citation?.text || 'Unknown Source',
          url: citation?.url,
          date: citation?.date || citation?.timestamp
        });

        if (result) {
          sources.push(result);
        }
      }

      return sources;
    } catch {
      return [];
    }
  }

  /**
   * Get model pricing
   */
  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    try {
      const models = ModelRegistry.getProviderModels('openrouter');
      const model = models.find(m => m.apiName === modelId);
      if (!model) {
        return null;
      }

      return {
        rateInputPerMillion: model.inputCostPerMillion,
        rateOutputPerMillion: model.outputCostPerMillion,
        currency: 'USD'
      };
    } catch {
      return null;
    }
  }

  private convertTools(tools: GenerateOptions['tools']): Array<{ type: 'function'; function: { name: string; description: string; parameters?: Record<string, unknown> } }> {
    if (!Array.isArray(tools)) {
      return [];
    }

    return tools.map(tool => {
      if (tool.type === 'function') {
        // Handle both nested (Chat Completions) and flat (Responses API) formats
        const toolDef = (tool.function || tool) as {
          name: string;
          description: string;
          parameters?: Record<string, unknown>;
          input_schema?: Record<string, unknown>;
        };
        return {
          type: 'function',
          function: {
            name: toolDef.name,
            description: toolDef.description,
            parameters: toolDef.parameters || toolDef.input_schema
          }
        };
      }
      return tool;
    });
  }
}
