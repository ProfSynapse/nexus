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
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  SearchResult,
  TokenUsage,
  CostDetails,
  Tool,
  ToolCall
} from '../types';
import { ModelRegistry } from '../ModelRegistry';
import { ReasoningPreserver } from '../shared/ReasoningPreserver';
import { WebSearchUtils } from '../../utils/WebSearchUtils';
import { BRAND_NAME } from '../../../../constants/branding';
import { MCPToolExecution } from '../shared/ToolExecutionUtils';
import { SSEToolCall } from '../../streaming/SSEStreamProcessor';

type JsonObject = Record<string, unknown>;

interface OpenRouterTool extends JsonObject {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: JsonObject;
    input_schema?: JsonObject;
  };
}

interface OpenRouterReasoningEntry {
  type?: string;
  text?: string;
  summary?: string;
  data?: string;
  id?: string;
  [key: string]: unknown;
}

interface OpenRouterAnnotation {
  type?: string;
  url?: string;
  title?: string;
  url_citation?: {
    title?: string;
    text?: string;
    url?: string;
    date?: string;
    timestamp?: string;
  };
}

interface OpenRouterToolCall extends SSEToolCall {
  id?: string;
  name?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  parameters?: Record<string, unknown>;
  reason?: string;
  reasoning_details?: OpenRouterReasoningEntry[];
  thought_signature?: string;
  thoughtSignature?: string;
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
}

interface OpenRouterChoice extends JsonObject {
  finish_reason?: string;
  text?: string;
  delta?: {
    content?: string;
    text?: string;
    tool_calls?: OpenRouterToolCall[];
    toolCalls?: OpenRouterToolCall[];
    reasoning_details?: OpenRouterReasoningEntry[];
    extra_content?: {
      google?: {
        thought_signature?: string;
      };
    };
    thought_signature?: string;
    thoughtSignature?: string;
  };
  message?: {
    content?: string;
    reasoning_details?: OpenRouterReasoningEntry[];
    annotations?: OpenRouterAnnotation[];
    extra_content?: {
      google?: {
        thought_signature?: string;
      };
    };
    thought_signature?: string;
    thoughtSignature?: string;
  };
  reasoning_details?: OpenRouterReasoningEntry[];
  thought_signature?: string;
  thoughtSignature?: string;
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
}

interface OpenRouterResponse extends JsonObject {
  id?: string;
  choices?: OpenRouterChoice[];
  reasoning_details?: OpenRouterReasoningEntry[];
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  data?: {
    native_tokens_prompt?: number;
    tokens_prompt?: number;
    native_tokens_completion?: number;
    tokens_completion?: number;
    total_cost?: number;
    currency?: string;
  };
  thoughtSignature?: string;
  message?: {
    annotations?: OpenRouterAnnotation[];
    content?: string;
  };
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

      const response = await this.request<OpenRouterResponse>({
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
      if (!data?.choices?.length) {
        throw new Error('OpenRouter generation returned an empty response');
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

      let messages = options?.conversationHistory || this.buildMessages(prompt, options?.systemPrompt);

      // Ensure system prompt is included when using conversationHistory
      // (buildToolContinuation strips system messages, expecting the adapter to re-add them)
      if (options?.conversationHistory && options?.systemPrompt) {
        const hasSystem = (messages as Array<{ role: string }>).some(m => m.role === 'system');
        if (!hasSystem) {
          messages = [{ role: 'system', content: options.systemPrompt }, ...messages];
        }
      }

      // Check if this model requires reasoning preservation (Gemini via OpenRouter)
      const needsReasoning = ReasoningPreserver.requiresReasoningPreservation(baseModel, 'openrouter');
      const hasTools = options?.tools && options.tools.length > 0;

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
        tools: options?.tools ? this.convertTools(options.tools) : undefined,
        stream: true,
        // Enable reasoning for Gemini models to capture thought signatures
        ...ReasoningPreserver.getReasoningRequestParams(baseModel, 'openrouter', hasTools || false)
      };

      // DIAGNOSTIC: log message structure for tool call debugging.
      // Helps diagnose Azure "Missing required parameter: input[N].call_id" errors.
      try {
        const summary = (messages as Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string } }>; content?: unknown }>).map((m, i) => {
          const tcIds = m.tool_calls?.map(tc => tc.id || '<MISSING>').join(',');
          const tcNames = m.tool_calls?.map(tc => tc.function?.name || '?').join(',');
          const contentPreview = typeof m.content === 'string'
            ? (m.content.length > 60 ? m.content.slice(0, 60) + '…' : m.content)
            : '[non-string]';
          return `[${i}] role=${m.role}` +
            (m.tool_call_id !== undefined ? ` tool_call_id=${m.tool_call_id || '<EMPTY>'}` : '') +
            (m.tool_calls ? ` tool_calls=[${tcIds}] (${tcNames})` : '') +
            ` content="${contentPreview}"`;
        }).join('\n  ');
        console.log(`[OpenRouter] Request to ${model} with ${(messages as unknown[]).length} messages:\n  ${summary}`);
      } catch (e) {
        console.warn('[OpenRouter] Failed to log message structure:', e);
      }

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
      let capturedReasoning: OpenRouterReasoningEntry[] | undefined = undefined;
      let capturedThoughtSignature: string | undefined = undefined;

      yield* this.processNodeStream(nodeStream, {
        debugLabel: 'OpenRouter',

        extractContent: (parsed) => {
          const response = parsed as OpenRouterResponse;
          // Capture generation ID from first chunk
          if (!generationId && response.id) {
            generationId = response.id;
          }

          // Capture reasoning_details for Gemini models (required for tool continuations)
          if (needsReasoning && !capturedReasoning) {
            capturedReasoning =
              response.reasoning_details ||
              response.choices?.[0]?.message?.reasoning_details ||
              response.choices?.[0]?.delta?.reasoning_details ||
              response.choices?.[0]?.reasoning_details ||
              (ReasoningPreserver.extractFromStreamChunk(response) as OpenRouterReasoningEntry[] | undefined);

          }

          // Capture thought_signature for Gemini models (OpenAI compatibility format)
          // Per Google docs, this can be in: extra_content.google.thought_signature
          // or directly on the delta/message
          if (needsReasoning && !capturedThoughtSignature) {
            const delta = response.choices?.[0]?.delta;
            const message = response.choices?.[0]?.message;

            capturedThoughtSignature =
              // OpenAI compatibility format per Google docs
              this.toOptionalString(delta?.extra_content?.google?.thought_signature) ||
              this.toOptionalString(message?.extra_content?.google?.thought_signature) ||
              this.toOptionalString(response.extra_content?.google?.thought_signature) ||
              // Direct formats
              this.toOptionalString(delta?.thought_signature) ||
              this.toOptionalString(delta?.thoughtSignature) ||
              this.toOptionalString(message?.thought_signature) ||
              this.toOptionalString(message?.thoughtSignature) ||
              this.toOptionalString(response.thought_signature) ||
              this.toOptionalString(response.thoughtSignature);

          }

          // Process all available choices - reasoning models may use multiple choices
          for (const choice of response.choices || []) {
            const delta = choice?.delta;
            const content = delta?.content || delta?.text || choice?.text;
            if (content) {
              return content;
            }
          }
          return null;
        },

        extractToolCalls: (parsed) => {
          const response = parsed as OpenRouterResponse;
          // Extract tool calls from any choice that has them
          for (const choice of response.choices || []) {
            let toolCalls = choice?.delta?.tool_calls || choice?.delta?.toolCalls;
            if (toolCalls) {
              // Extract reasoning_details from this chunk (it may contain encrypted thought signatures)
              const chunkReasoningDetails = choice?.delta?.reasoning_details;
              if (chunkReasoningDetails && Array.isArray(chunkReasoningDetails)) {
                // Look for reasoning.encrypted entries - these contain the thought_signature
                for (const entry of chunkReasoningDetails) {
                  if (!entry || typeof entry !== 'object') {
                    continue;
                  }
                  const reasoningEntry = entry;
                  if (reasoningEntry.type === 'reasoning.encrypted' && reasoningEntry.data && reasoningEntry.id) {
                    // Match encrypted entry to tool call by id
                    for (const tc of toolCalls) {
                      if (tc.id === reasoningEntry.id || tc.id?.startsWith(reasoningEntry.id?.split('_').slice(0, -1).join('_'))) {
                        tc.thought_signature = reasoningEntry.data;
                      }
                    }
                    // Also store as fallback
                    if (!capturedThoughtSignature) {
                      capturedThoughtSignature = reasoningEntry.data;
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
                const tcThoughtSig =
                  tc.thought_signature ||
                  tc.thoughtSignature ||
                  tc.extra_content?.google?.thought_signature;
                if (tcThoughtSig && !tc.thought_signature) {
                  tc.thought_signature = tcThoughtSig;
                }
              }

              // Attach reasoning data (both reasoning_details AND thought_signature)
              const hasReasoning = capturedReasoning || capturedThoughtSignature;
              if (hasReasoning) {
                toolCalls = ReasoningPreserver.attachToToolCalls(
                  toolCalls as unknown as Array<Record<string, unknown>>,
                  {
                    reasoning_details: capturedReasoning,
                    thought_signature: capturedThoughtSignature
                  }
                ) as unknown as OpenRouterToolCall[];
              }
              return toolCalls as unknown as SSEToolCall[];
            }
          }
          return null;
        },

        extractFinishReason: (parsed) => {
          const response = parsed as OpenRouterResponse;
          // Extract finish reason from any choice
          for (const choice of response.choices || []) {
            if (choice?.finish_reason) {
              // Last chance to capture thought_signature from final chunk
              if (needsReasoning && !capturedThoughtSignature) {
                const delta = choice?.delta;
                const message = choice?.message;
                capturedThoughtSignature =
                  this.toOptionalString(delta?.extra_content?.google?.thought_signature) ||
                  this.toOptionalString(message?.extra_content?.google?.thought_signature) ||
                  this.toOptionalString(response.extra_content?.google?.thought_signature) ||
                  this.toOptionalString(delta?.thought_signature) ||
                  this.toOptionalString(message?.thought_signature) ||
                  this.toOptionalString(response.thought_signature) ||
                  this.toOptionalString(choice?.thought_signature);

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

        extractUsage: (_parsed) => {
          // OpenRouter doesn't include usage in streaming responses
          // We'll fetch it asynchronously using the generation ID when completion is detected
          return undefined;
        },

        // Extract reasoning from reasoning_details array (OpenRouter unified format)
        extractReasoning: (parsed) => {
          const response = parsed as OpenRouterResponse;
          // Check for reasoning_details in delta or message
          const reasoningDetails =
            response.choices?.[0]?.delta?.reasoning_details ||
            response.choices?.[0]?.message?.reasoning_details ||
            response.reasoning_details;

          if (reasoningDetails && Array.isArray(reasoningDetails)) {
            // Find reasoning.text entries (these contain the actual reasoning text)
            const textEntries = reasoningDetails.filter((r): r is OpenRouterReasoningEntry => !!r && typeof r === 'object' && (r).type === 'reasoning.text');
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
            const summaryEntries = reasoningDetails.filter((r): r is OpenRouterReasoningEntry => !!r && typeof r === 'object' && (r).type === 'reasoning.summary');
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
    let cost: CostDetails | undefined;
    if (stats.totalCost !== undefined) {
      const calculatedCost = await this.calculateCost(usage, model);
      if (calculatedCost) {
        cost = {
          ...calculatedCost,
          totalCost: stats.totalCost,
          currency: stats.currency || calculatedCost.currency
        };
      }
    } else {
      cost = await this.calculateCost(usage, model) ?? undefined;
    }

    // Notify via callback
    onUsageAvailable(usage, cost);
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

        const response = await this.request<OpenRouterResponse>({
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
        if (!data?.data) {
          return null;
        }

        // Extract token counts from response
        // OpenRouter returns: tokens_prompt, tokens_completion, native_tokens_prompt, native_tokens_completion
        const promptTokens = data.data.native_tokens_prompt || data.data.tokens_prompt || 0;
        const completionTokens = data.data.native_tokens_completion || data.data.tokens_completion || 0;
        const totalCost = data.data.total_cost ?? undefined;
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
  listModels(): Promise<ModelInfo[]> {
    try {
      // Use centralized model registry
      const openrouterModels = ModelRegistry.getProviderModels('openrouter');
      return Promise.resolve(openrouterModels.map(model => ModelRegistry.toModelInfo(model)));
    } catch (error) {
      this.handleError(error, 'listing models');
      return Promise.resolve([]);
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
  private async executeDetectedToolCalls(detectedToolCalls: ToolCall[], model: string, prompt: string, options?: GenerateOptions): Promise<LLMResponse> {

    try {
      // Convert to MCP format
      const mcpToolCalls: ToolCall[] = detectedToolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function?.name || tc.name || 'function_call',
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
      );


      // Now do the "pingpong" - send the conversation with tool results back to the LLM
      const messages: Array<Record<string, unknown>> = this.buildMessages(prompt, options?.systemPrompt);

      // Build assistant message with reasoning preserved using centralized utility
      const assistantMessage = ReasoningPreserver.buildAssistantMessageWithReasoning(
        detectedToolCalls as unknown as Array<Record<string, unknown>>,
        '' // Empty content since this was a tool call
      );

      messages.push(assistantMessage);

      // Add tool result messages
      const toolMessages = MCPToolExecution.buildToolMessages(toolResults, 'openrouter');
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
      
      const response = await this.request<OpenRouterResponse>({
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

      const rawData: unknown = response.json;
      const data = toOpenRouterResponse(rawData);
      if (!data?.choices?.length) {
        throw new Error('OpenRouter tool execution returned an empty response');
      }
      const choice = data.choices[0];
      const finalContent = choice?.message?.content || 'No response from AI after tool execution';
      const usage = this.extractUsage(data);


      // Combine original tool calls with their execution results
      const completeToolCalls: ToolCall[] = detectedToolCalls.map(originalCall => {
        const result = toolResults.find(r => r.id === originalCall.id);
        return {
          id: originalCall.id,
          type: 'function',
          name: originalCall.function?.name || originalCall.name || 'function_call',
          function: {
            name: originalCall.function?.name || originalCall.name || 'function_call',
            arguments: originalCall.function?.arguments || '{}'
          },
          parameters: parseToolArguments(originalCall.function?.arguments),
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
        { toolMetadata: MCPToolExecution.buildToolMetadata(toolResults) },
        (choice?.finish_reason === 'stop' ||
          choice?.finish_reason === 'length' ||
          choice?.finish_reason === 'tool_calls' ||
          choice?.finish_reason === 'content_filter')
          ? choice.finish_reason
          : 'stop',
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
  private extractOpenRouterSources(response: OpenRouterResponse): SearchResult[] {
    try {
      const annotations = response.choices?.[0]?.message?.annotations || [];
      const sources = annotations
        .filter((ann): ann is OpenRouterAnnotation & { type: 'url_citation'; url_citation: NonNullable<OpenRouterAnnotation['url_citation']> } => ann.type === 'url_citation')
        .map((ann) => {
          const citation = ann.url_citation;
          return WebSearchUtils.validateSearchResult({
            title: citation?.title || citation?.text || 'Unknown Source',
            url: citation?.url,
            date: citation?.date || citation?.timestamp
          });
        })
        .filter((result: SearchResult | null): result is SearchResult => result !== null);

      return sources;
    } catch {
      return [];
    }
  }

  /**
   * Get model pricing
   */
  getModelPricing(modelId: string): Promise<ModelPricing | null> {
    try {
      const models = ModelRegistry.getProviderModels('openrouter');
      const model = models.find(m => m.apiName === modelId);
      if (!model) {
        return Promise.resolve(null);
      }

      return Promise.resolve({
        rateInputPerMillion: model.inputCostPerMillion,
        rateOutputPerMillion: model.outputCostPerMillion,
        currency: 'USD'
      });
    } catch {
      return Promise.resolve(null);
    }
  }

  private convertTools(tools: Tool[]): OpenRouterTool[] {
    return tools.flatMap(tool => {
      if (tool.type !== 'function' || !tool.function) {
        return [];
      }

      const toolDef = tool.function;
      return [{
        type: 'function',
        function: {
          name: toolDef.name,
          description: toolDef.description,
          parameters: toolDef.parameters
        }
      }];
    });
  }

  private toOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toOpenRouterResponse(value: unknown): OpenRouterResponse {
  if (!isRecord(value)) {
    return {};
  }

  return value as OpenRouterResponse;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.trim() === '') {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
