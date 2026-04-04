/**
 * OpenAI Adapter - Clean implementation focused on streaming
 * Location: src/services/llm/adapters/openai/OpenAIAdapter.ts
 *
 * Supports both regular chat completions and deep research models.
 * Uses OpenAI's REST API over requestUrl with buffered SSE replay.
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
  Tool,
  TokenUsage,
  ToolCall
} from '../types';
import { ModelRegistry } from '../ModelRegistry';
import { DeepResearchHandler } from './DeepResearchHandler';
import { WebSearchUtils } from '../../utils/WebSearchUtils';
import { OPENAI_MODELS } from './OpenAIModels';
import { ProviderHttpError } from '../shared/ProviderHttpClient';

interface OpenAIResponsesTool {
  type: string;
  name?: string;
  description?: string | null;
  parameters?: unknown;
  strict?: boolean | null;
  function?: {
    name?: string;
    description?: string | null;
    parameters?: unknown;
    strict?: boolean | null;
  };
}

interface OpenAIResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface OpenAIResponsesContentPart {
  type?: string;
  text?: string;
}

interface OpenAIResponsesItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  encrypted_content?: string | null;
  content?: OpenAIResponsesContentPart[];
  usage?: OpenAIResponsesUsage;
}

interface OpenAIResponsesEvent {
  type?: string;
  delta?: string;
  item?: OpenAIResponsesItem;
  part?: {
    type?: string;
    text?: string;
  };
  response?: {
    id?: string;
    usage?: OpenAIResponsesUsage;
  };
  output_index?: number;
  text?: string;
  item_id?: string;
}

interface OpenAIResponsesResponse {
  id?: string;
  status?: string;
  output?: OpenAIResponsesItem[];
  usage?: OpenAIResponsesUsage;
  metadata?: {
    processing_time_ms?: number;
  };
}

interface OpenAIChatMessageLike {
  annotations?: Array<{
    type?: string;
    title?: string;
    text?: string;
    url?: string;
    date?: string;
    timestamp?: string;
  }>;
  toolCalls?: Array<{
    function?: {
      name?: string;
    };
    result?: string;
  }>;
}

interface OpenAIChatResponseLike {
  choices?: Array<{
    message?: OpenAIChatMessageLike;
  }>;
}

interface OpenAIResponsesRequest {
  model: string;
  stream: boolean;
  input?: string | Array<Record<string, unknown>>;
  instructions?: string;
  previous_response_id?: string;
  tools?: OpenAIResponsesTool[];
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  reasoning?: {
    effort: string;
    summary: string;
  };
  include?: string[];
}

export class OpenAIAdapter extends BaseAdapter {
  readonly name = 'openai';
  readonly baseUrl = 'https://api.openai.com/v1';

  private deepResearch: DeepResearchHandler;

  constructor(apiKey: string) {
    super(apiKey, 'gpt-5.4');
    this.deepResearch = new DeepResearchHandler(this.apiKey, this.baseUrl);
    this.initializeCache();
  }

  /**
   * Generate response without caching
   */
  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    try {
      // Validate web search support
      if (options?.webSearch) {
        WebSearchUtils.validateWebSearchRequest('openai', options.webSearch);
      }

      const model = options?.model || this.currentModel;

      // Route deep research models to specialized handler
      if (this.deepResearch.isDeepResearchModel(model)) {
        return await this.deepResearch.generate(prompt, options);
      }

      // Tool execution requires streaming - use generateStreamAsync instead
      if (options?.tools && options.tools.length > 0) {
        throw new Error('Tool execution requires streaming. Use generateStreamAsync() instead.');
      }

      // Otherwise use basic Responses API without tools
      return await this.generateWithResponsesAPI(prompt, options);
    } catch (error) {
      this.handleError(error, 'generation');
    }
  }

  /**
   * Generate streaming response using async generator
   * Uses OpenAI Responses API for stateful conversations with tool support
   */
  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    let lastRequestSummary: Record<string, unknown> | undefined;

    try {
      const model = options?.model || this.currentModel;

      // Deep research models cannot be used in streaming chat
      if (this.deepResearch.isDeepResearchModel(model)) {
        throw new Error(`Deep research models (${model}) cannot be used in streaming chat. Please select a different model for real-time conversations.`);
      }

      // Build Responses API parameters with retry logic for race conditions
      const stream = await this.retryWithBackoff(async () => {
        const responseParams: OpenAIResponsesRequest = {
          model,
          stream: true
        };

        // Handle input - either tool outputs (continuation) or text (initial)
        if (options?.conversationHistory && options.conversationHistory.length > 0) {
          // Tool continuation: conversationHistory contains ResponseInputItem[] (function_call_output)
          responseParams.input = options.conversationHistory;
        } else {
          // Initial request: use text input
          responseParams.input = prompt;
        }

        // Add instructions (replaces system message in Chat Completions)
        if (options?.systemPrompt) {
          responseParams.instructions = options.systemPrompt;
        }

        // Add previous_response_id for stateful continuation
        if (options?.previousResponseId) {
          responseParams.previous_response_id = options.previousResponseId;
        }

        // Add tools if provided (convert from Chat Completions format to Responses API format)
        if (options?.tools) {
          responseParams.tools = options.tools.map((tool: Tool) => {
            // Responses API uses flat structure: {type, name, description, parameters}
            // Chat Completions uses nested: {type, function: {name, description, parameters}}
            if (tool.function) {
              const functionTool = tool.function as NonNullable<Tool['function']> & { strict?: boolean | null };
              return {
                type: 'function',
                name: functionTool.name,
                description: functionTool.description || null,
                parameters: functionTool.parameters || null,
                strict: functionTool.strict || null
              };
            }
            // Already in Responses API format
            return tool as OpenAIResponsesTool;
          });
        }

        // Add optional parameters
        if (options?.temperature !== undefined) responseParams.temperature = options.temperature;
        if (options?.maxTokens !== undefined) responseParams.max_output_tokens = options.maxTokens;
        if (options?.topP !== undefined) responseParams.top_p = options.topP;
        if (options?.frequencyPenalty !== undefined) responseParams.frequency_penalty = options.frequencyPenalty;
        if (options?.presencePenalty !== undefined) responseParams.presence_penalty = options.presencePenalty;

        // Enable reasoning for GPT-5/o-series models if thinking is enabled
        // This enables chain-of-thought reasoning that streams to the UI
        if (options?.enableThinking && this.supportsReasoning(model)) {
          responseParams.reasoning = {
            effort: options.thinkingEffort || 'medium',  // Use user-selected effort level
            summary: 'auto'    // Can be 'auto', 'concise', or 'detailed'
          };
          // Include encrypted_content for multi-turn conversations
          responseParams.include = responseParams.include || [];
          responseParams.include.push('reasoning.encrypted_content');
        }

        lastRequestSummary = this.buildStreamingRequestSummary(responseParams, options, prompt);

        const nodeStream = await this.requestStream({
          url: `${this.baseUrl}/responses`,
          operation: 'streaming generation',
          method: 'POST',
          headers: this.buildOpenAIHeaders(),
          body: JSON.stringify(responseParams),
          timeoutMs: 120_000
        });

        return nodeStream;
      });

      yield* this.processResponsesNodeStream(stream);

    } catch (error) {
      this.logStreamingFailure(error, lastRequestSummary);
      console.error('[OpenAIAdapter] Streaming error:', error);
      this.handleError(error, 'streaming generation');
    }
  }

  private buildStreamingRequestSummary(
    responseParams: OpenAIResponsesRequest,
    options: GenerateOptions | undefined,
    prompt: string
  ): Record<string, unknown> {
    const input = responseParams.input;
    const inputItems = Array.isArray(input) ? input : null;
    const toolNames = responseParams.tools
      ?.map(tool => tool.name)
      .filter((name): name is string => Boolean(name)) || [];

    return {
      model: responseParams.model,
      previousResponseId: responseParams.previous_response_id,
      hasSystemPrompt: Boolean(options?.systemPrompt),
      systemPromptLength: options?.systemPrompt?.length || 0,
      promptLength: prompt.length,
      inputMode: inputItems ? 'continuation' : 'prompt',
      continuationItemCount: inputItems?.length || 0,
      continuationItemTypes: inputItems?.map(item => {
        if (item && typeof item === 'object' && 'type' in item && typeof item.type === 'string') {
          return item.type;
        }
        if (item && typeof item === 'object' && 'role' in item && typeof item.role === 'string') {
          return `role:${item.role}`;
        }
        return typeof item;
      }) || [],
      continuationCallIds: inputItems?.flatMap(item => {
        if (item && typeof item === 'object' && 'call_id' in item && typeof item.call_id === 'string') {
          return [item.call_id];
        }
        return [];
      }) || [],
      toolCount: toolNames.length,
      toolNames,
      temperature: responseParams.temperature,
      maxOutputTokens: responseParams.max_output_tokens,
      thinkingEnabled: Boolean(responseParams.reasoning),
      thinkingEffort: isRecord(responseParams.reasoning) ? responseParams.reasoning.effort : undefined
    };
  }

  private logStreamingFailure(error: unknown, requestSummary?: Record<string, unknown>): void {
    if (!(error instanceof ProviderHttpError)) {
      return;
    }

    const responseJson = this.sanitizeForLogging(error.response.json);
    const responseText = typeof error.response.text === 'string'
      ? error.response.text.slice(0, 2000)
      : undefined;
    const missingCallId = this.extractMissingToolCallId(error.response);
    const continuationCallIds = Array.isArray(requestSummary?.continuationCallIds)
      ? requestSummary?.continuationCallIds
      : [];

    console.error('[OpenAIAdapter] Streaming request failed', {
      status: error.response.status,
      statusText: error.response.statusText,
      request: requestSummary,
      diagnostics: missingCallId ? {
        missingCallId,
        requestIncludesMissingCallId: continuationCallIds.includes(missingCallId),
        continuationCallIds
      } : undefined,
      responseJson,
      responseText
    });
  }

  private extractMissingToolCallId(response: { json?: unknown; text?: string }): string | undefined {
    const messageFromJson = isRecord(response.json) &&
      isRecord(response.json.error) &&
      typeof response.json.error.message === 'string'
      ? response.json.error.message
      : undefined;

    const message = messageFromJson || response.text;
    if (typeof message !== 'string') {
      return undefined;
    }

    const match = message.match(/function call ([A-Za-z0-9_-]+)/);
    return match?.[1];
  }

  private sanitizeForLogging(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.slice(0, 10).map(item => this.sanitizeForLogging(item));
    }

    if (!isRecord(value)) {
      if (typeof value === 'string') {
        return value.length > 500 ? `${value.slice(0, 500)}...` : value;
      }
      return value;
    }

    const sanitizedEntries = Object.entries(value).slice(0, 20).map(([key, entryValue]) => {
      if (typeof entryValue === 'string') {
        return [key, entryValue.length > 500 ? `${entryValue.slice(0, 500)}...` : entryValue];
      }

      if (Array.isArray(entryValue)) {
        return [key, entryValue.slice(0, 10).map(item => this.sanitizeForLogging(item))];
      }

      if (isRecord(entryValue)) {
        return [key, this.sanitizeForLogging(entryValue)];
      }

      return [key, entryValue];
    });

    return Object.fromEntries(sanitizedEntries);
  }

  /**
   * Process Responses API events from a Node.js readable stream.
   * Reads SSE events incrementally as they arrive from the wire.
   */
  private async* processResponsesNodeStream(nodeStream: NodeJS.ReadableStream): AsyncGenerator<StreamChunk, void, unknown> {
    const { createParser } = await import('eventsource-parser');

    let currentResponseId: string | null = null;
    const toolCallsMap = new Map<number, ToolCall>();
    let usage: TokenUsage | undefined;

    // Reasoning tracking for GPT-5/o-series models
    let currentReasoningId: string | null = null;
    let currentReasoningEncryptedContent: string | null = null;
    let isInReasoningPart = false;
    let isCompleted = false;

    const eventQueue: StreamChunk[] = [];

    const parser = createParser((sseEvent) => {
      if (sseEvent.type === 'reconnect-interval' || isCompleted) return;
      if (sseEvent.data === '[DONE]') {
        isCompleted = true;
        return;
      }

      let event: OpenAIResponsesEvent;
      try {
        event = JSON.parse(sseEvent.data) as OpenAIResponsesEvent;
      } catch {
        return;
      }

      if (event.response?.id && !currentResponseId) {
        currentResponseId = event.response.id;
      }

      switch (event.type) {
        case 'response.output_text.delta':
          if (event.delta) {
            eventQueue.push({ content: event.delta, complete: false });
          }
          break;

        case 'response.output_item.added':
          if (event.item) {
            const item = event.item;
            if (item.type === 'reasoning') {
                currentReasoningId = item.id || null;
                eventQueue.push({
                  content: '', complete: false, reasoning: '',
                  reasoningComplete: false, reasoningId: item.id || undefined
                });
              } else if (item.type === 'message' && item.content) {
                for (const c of item.content) {
                  if (c.type === 'text' && c.text) {
                    eventQueue.push({ content: c.text, complete: false });
                  }
                }
              }
          }
          break;

        case 'response.content_part.added':
          if (event.part?.type === 'reasoning_text') {
            isInReasoningPart = true;
            if (event.part.text) {
              eventQueue.push({
                content: '', complete: false, reasoning: event.part.text,
                reasoningComplete: false, reasoningId: currentReasoningId || undefined
              });
            }
          }
          break;

        case 'response.content_part.delta':
          if (isInReasoningPart && event.delta) {
            eventQueue.push({
              content: '', complete: false, reasoning: event.delta,
              reasoningComplete: false, reasoningId: currentReasoningId || undefined
            });
          }
          break;

        case 'response.content_part.done':
          if (event.part?.type === 'reasoning_text') isInReasoningPart = false;
          break;

        case 'response.output_item.done':
          if (event.item) {
            const item = event.item;
            if (item.type === 'function_call') {
              toolCallsMap.set(event.output_index || 0, {
                id: item.call_id || item.id || '',
                type: 'function',
                function: { name: item.name || '', arguments: item.arguments || '{}' }
              });
            } else if (item.type === 'reasoning') {
              currentReasoningEncryptedContent = item.encrypted_content || null;
              eventQueue.push({
                content: '', complete: false, reasoning: '', reasoningComplete: true,
                reasoningId: item.id || currentReasoningId || undefined,
                reasoningEncryptedContent: currentReasoningEncryptedContent || undefined
              });
              currentReasoningId = null;
            }
          }
          break;

        case 'response.function_call_arguments.delta':
          break;

        case 'response.reasoning_summary_text.delta':
          if (event.delta) {
            eventQueue.push({
              content: '', complete: false, reasoning: event.delta,
              reasoningComplete: false, reasoningId: event.item_id || currentReasoningId || undefined
            });
          }
          break;

        case 'response.reasoning_summary_text.done':
          if (event.text) {
            eventQueue.push({
              content: '', complete: false, reasoning: '', reasoningComplete: true,
              reasoningId: event.item_id || currentReasoningId || undefined
            });
          }
          break;

        case 'response.reasoning_summary_part.done':
          eventQueue.push({
            content: '', complete: false, reasoning: '', reasoningComplete: true,
            reasoningId: event.item_id || currentReasoningId || undefined
          });
          break;

        case 'response.done':
        case 'response.completed': {
          if (event.response?.usage) {
            usage = {
              promptTokens: event.response.usage.input_tokens || 0,
              completionTokens: event.response.usage.output_tokens || 0,
              totalTokens: event.response.usage.total_tokens || 0
            };
          }
          const metadata = currentResponseId ? { responseId: currentResponseId } : undefined;
          const toolCallsArray = Array.from(toolCallsMap.values());
          eventQueue.push({
            content: '', complete: true, usage,
            toolCalls: toolCallsArray.length > 0 ? toolCallsArray : undefined,
            toolCallsReady: toolCallsArray.length > 0,
            metadata
          });
          isCompleted = true;
          break;
        }
      }
    });

    try {
      for await (const chunk of nodeStream as AsyncIterable<Buffer>) {
        if (isCompleted) break;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        parser.feed(text);

        while (eventQueue.length > 0) {
          const evt = eventQueue.shift();
          if (!evt) {
            break;
          }
          yield evt;
          if (evt.complete) { isCompleted = true; break; }
        }
      }

      while (eventQueue.length > 0) {
        const evt = eventQueue.shift();
        if (!evt) {
          continue;
        }
        yield evt;
      }

      if (!isCompleted) {
        yield { content: '', complete: true, usage };
      }
    } catch (error) {
      console.error('[OpenAIAdapter] Error processing Responses API stream:', error);
      throw error;
    }
  }

  /**
   * Generate using Responses API for non-streaming requests
   */
  private async generateWithResponsesAPI(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = options?.model || this.currentModel;

    const responseParams: OpenAIResponsesRequest = {
      model,
      input: prompt,
      stream: false
    };

    // Add instructions (replaces system message)
    if (options?.systemPrompt) {
      responseParams.instructions = options.systemPrompt;
    }

    // Add optional parameters
    if (options?.temperature !== undefined) responseParams.temperature = options.temperature;
    if (options?.maxTokens !== undefined) responseParams.max_output_tokens = options.maxTokens;
    if (options?.topP !== undefined) responseParams.top_p = options.topP;
    if (options?.frequencyPenalty !== undefined) responseParams.frequency_penalty = options.frequencyPenalty;
    if (options?.presencePenalty !== undefined) responseParams.presence_penalty = options.presencePenalty;

    const response = await this.request<OpenAIResponsesResponse>({
      url: `${this.baseUrl}/responses`,
      operation: 'generation',
      method: 'POST',
      headers: this.buildOpenAIHeaders(),
      body: JSON.stringify(responseParams),
      timeoutMs: 60_000
    });
    this.assertOk(response, `OpenAI generation failed: HTTP ${response.status}`);

    const responseJson = response.json;
    if (!responseJson) {
      throw new Error('No output from OpenAI Responses API');
    }

    if (!responseJson.output || responseJson.output.length === 0) {
      throw new Error('No output from OpenAI Responses API');
    }

    // Extract text content from output array
    let text = '';
    for (const item of responseJson.output) {
      if (item.type === 'message' && item.content) {
        for (const content of item.content) {
          if (content.type === 'output_text') {
            text += content.text || '';
          }
        }
      }
    }

    const usage: TokenUsage | undefined = responseJson.usage ? {
      promptTokens: responseJson.usage.input_tokens || 0,
      completionTokens: responseJson.usage.output_tokens || 0,
      totalTokens: responseJson.usage.total_tokens || 0
    } : undefined;

    return this.buildLLMResponse(
      text,
      model,
      usage,
      { responseId: responseJson.id },
      'stop'
    );
  }

  private buildOpenAIHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`
    };
  }

  /**
   * Parse SSE event blocks from buffered text.
   * Per the SSE spec, an event block can contain multiple `data:` lines
   * which must be concatenated with newlines to form the complete payload.
   */
  private *parseSSEEvents(sseText: string): Generator<OpenAIResponsesEvent, void, unknown> {
    const events = sseText.split('\n\n');

    for (const eventBlock of events) {
      const lines = eventBlock.split('\n');

      // Collect all data: lines in this event block and concatenate per SSE spec
      const dataLines: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          dataLines.push(trimmed.replace(/^data:\s*/, ''));
        }
      }

      if (dataLines.length === 0) {
        continue;
      }

      const payload = dataLines.join('\n').trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }

      try {
        yield JSON.parse(payload);
      } catch {
        continue;
      }
    }
  }

  /**
   * Extract search results from OpenAI response
   * OpenAI may include sources in annotations or tool results
   */
  private extractOpenAISources(response: OpenAIChatResponseLike): SearchResult[] {
    try {
      const sources: SearchResult[] = [];

      // Check for annotations (if OpenAI includes web sources)
      const annotations = response.choices?.[0]?.message?.annotations || [];
      for (const annotation of annotations) {
        if (annotation.type === 'url_citation' || annotation.type === 'citation') {
          const result = WebSearchUtils.validateSearchResult({
            title: annotation.title || annotation.text || 'Unknown Source',
            url: annotation.url,
            date: annotation.date || annotation.timestamp
          });
          if (result) sources.push(result);
        }
      }

      // Check for tool calls with web search results
      const toolCalls = response.choices?.[0]?.message?.toolCalls || [];
      for (const toolCall of toolCalls) {
        if (toolCall.function?.name === 'web_search' && toolCall.result) {
          try {
            const searchResult: unknown = JSON.parse(toolCall.result);
            if (isRecord(searchResult)) {
              const rawSources = searchResult.sources;
              if (Array.isArray(rawSources)) {
                const extractedSources = WebSearchUtils.extractSearchResults(rawSources);
                sources.push(...extractedSources);
              }
            }
          } catch {
            continue;
          }
        }
      }

      return sources;
    } catch {
      return [];
    }
  }

  /**
   * List available models
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      // Use centralized model registry instead of API call
      const openaiModels = ModelRegistry.getProviderModels('openai');
      return openaiModels.map(model => ModelRegistry.toModelInfo(model));
    } catch {
      return [];
    }
  }


  /**
   * Check if model supports reasoning/thinking (uses model registry)
   */
  private supportsReasoning(modelId: string): boolean {
    const model = OPENAI_MODELS.find(m => m.apiName === modelId);
    return model?.capabilities.supportsThinking || false;
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
      supportsThinking: true,
      supportsImageGeneration: true,
      maxContextWindow: 1050000, // GPT-5.4/GPT-5.4 Pro context window
      supportedFeatures: [
        'streaming',
        'json_mode',
        'function_calling',
        'image_input',
        'image_generation',
        'thinking_models',
        'deep_research'
      ]
    };

    return baseCapabilities;
  }

  /**
   * Get model pricing
   */
  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    try {
      const models = ModelRegistry.getProviderModels('openai');
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
