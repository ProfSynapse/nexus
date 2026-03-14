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
  SearchResult
} from '../types';
import { ModelRegistry } from '../ModelRegistry';
import { DeepResearchHandler } from './DeepResearchHandler';
import { WebSearchUtils } from '../../utils/WebSearchUtils';
import { OPENAI_MODELS } from './OpenAIModels';
import { MCPToolExecution } from '../shared/ToolExecutionUtils';

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
      throw this.handleError(error, 'generation');
    }
  }

  /**
   * Generate streaming response using async generator
   * Uses OpenAI Responses API for stateful conversations with tool support
   */
  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      const model = options?.model || this.currentModel;

      // Deep research models cannot be used in streaming chat
      if (this.deepResearch.isDeepResearchModel(model)) {
        throw new Error(`Deep research models (${model}) cannot be used in streaming chat. Please select a different model for real-time conversations.`);
      }

      // Build Responses API parameters with retry logic for race conditions
      const stream = await this.retryWithBackoff(async () => {
        const responseParams: any = {
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
          responseParams.tools = options.tools.map((tool: any) => {
            // Responses API uses flat structure: {type, name, description, parameters}
            // Chat Completions uses nested: {type, function: {name, description, parameters}}
            if (tool.function) {
              return {
                type: 'function',
                name: tool.function.name,
                description: tool.function.description || null,
                parameters: tool.function.parameters || null,
                strict: tool.function.strict || null
              };
            }
            // Already in Responses API format
            return tool;
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
      console.error('[OpenAIAdapter] Streaming error:', error);
      throw this.handleError(error, 'streaming generation');
    }
  }

  /**
   * Process Responses API events from a Node.js readable stream.
   * Reads SSE events incrementally as they arrive from the wire.
   */
  private async* processResponsesNodeStream(nodeStream: NodeJS.ReadableStream): AsyncGenerator<StreamChunk, void, unknown> {
    const { createParser } = await import('eventsource-parser');

    let fullContent = '';
    let currentResponseId: string | null = null;
    const toolCallsMap = new Map<number, any>();
    let usage: any = null;

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

      let event: Record<string, any>;
      try {
        event = JSON.parse(sseEvent.data);
      } catch {
        return;
      }

      if (event.response?.id && !currentResponseId) {
        currentResponseId = event.response.id;
      }

      switch (event.type) {
        case 'response.output_text.delta':
          if (event.delta) {
            fullContent += event.delta;
            eventQueue.push({ content: event.delta, complete: false });
          }
          break;

        case 'response.output_item.added':
          if (event.item) {
            const item = event.item;
            if (item.type === 'reasoning') {
              currentReasoningId = item.id;
              eventQueue.push({
                content: '', complete: false, reasoning: '',
                reasoningComplete: false, reasoningId: item.id
              });
            } else if (item.type === 'message' && item.content) {
              for (const c of item.content) {
                if (c.type === 'text' && c.text) {
                  fullContent += c.text;
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
                id: item.call_id || item.id,
                type: 'function',
                function: { name: item.name || '', arguments: item.arguments || '{}' }
              });
            } else if (item.type === 'reasoning') {
              currentReasoningEncryptedContent = item.encrypted_content || null;
              eventQueue.push({
                content: '', complete: false, reasoning: '', reasoningComplete: true,
                reasoningId: item.id,
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
        case 'response.completed':
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
    });

    try {
      for await (const chunk of nodeStream as AsyncIterable<Buffer>) {
        if (isCompleted) break;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        parser.feed(text);

        while (eventQueue.length > 0) {
          const evt = eventQueue.shift()!;
          yield evt;
          if (evt.complete) { isCompleted = true; break; }
        }
      }

      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
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

    const responseParams: any = {
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

    const response = await this.request<any>({
      url: `${this.baseUrl}/responses`,
      operation: 'generation',
      method: 'POST',
      headers: this.buildOpenAIHeaders(),
      body: JSON.stringify(responseParams),
      timeoutMs: 60_000
    });
    this.assertOk(response, `OpenAI generation failed: HTTP ${response.status}`);

    const responseJson = response.json;

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

    const usage = responseJson.usage ? {
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
  private *parseSSEEvents(sseText: string): Generator<Record<string, any>, void, unknown> {
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
  private extractOpenAISources(response: any): SearchResult[] {
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
            const searchResult = JSON.parse(toolCall.result);
            if (searchResult.sources && Array.isArray(searchResult.sources)) {
              const extractedSources = WebSearchUtils.extractSearchResults(searchResult.sources);
              sources.push(...extractedSources);
            }
          } catch (error) {
          }
        }
      }

      return sources;
    } catch (error) {
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
    } catch (error) {
      this.handleError(error, 'listing models');
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
    } catch (error) {
      return null;
    }
  }
}
