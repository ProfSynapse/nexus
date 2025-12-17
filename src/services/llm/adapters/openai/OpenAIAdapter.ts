/**
 * OpenAI Adapter - Clean implementation focused on streaming
 * Supports both regular chat completions and deep research models
 */

import OpenAI from 'openai';
import { Stream } from 'openai/streaming';
import { BaseAdapter } from '../BaseAdapter';

// OpenAI Responses API types - using namespace for proper type access
type OpenAIResponse = OpenAI.Responses.Response;
type OpenAIStreamEvent = OpenAI.Responses.ResponseStreamEvent;
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

  private client: OpenAI;
  private deepResearch: DeepResearchHandler;

  constructor(apiKey: string) {
    super(apiKey, 'gpt-5');

    this.client = new OpenAI({
      apiKey: this.apiKey,
      dangerouslyAllowBrowser: true, // Required for Obsidian plugin environment
    });

    this.deepResearch = new DeepResearchHandler(this.client);
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

        // Create Responses API stream
        // TypeScript can't narrow the overloaded create() return type based on params,
        // so we cast to the expected streaming type
        return await this.client.responses.create(responseParams) as unknown as Stream<OpenAIStreamEvent>;
      });

      // Process Responses API stream events
      yield* this.processResponsesStream(stream);

    } catch (error) {
      console.error('[OpenAIAdapter] Streaming error:', error);
      throw this.handleError(error, 'streaming generation');
    }
  }

  /**
   * Process Responses API stream events
   * Handles ResponseStreamEvent format from OpenAI Responses API
   * Includes reasoning/thinking support for GPT-5 and o-series models
   * @private
   */
  private async* processResponsesStream(stream: any): AsyncGenerator<StreamChunk, void, unknown> {
    let fullContent = '';
    let currentResponseId: string | null = null;
    const toolCallsMap = new Map<number, any>();
    let usage: any = null;

    // Reasoning tracking for GPT-5/o-series models
    let currentReasoningId: string | null = null;
    let currentReasoningEncryptedContent: string | null = null;
    let isInReasoningPart = false;

    try {
      for await (const event of stream) {
        // Extract response ID from events
        if (event.response?.id && !currentResponseId) {
          currentResponseId = event.response.id;
        }

        // Handle different event types
        switch (event.type) {
          case 'response.output_text.delta':
            // Text content delta
            if (event.delta) {
              fullContent += event.delta;
              yield {
                content: event.delta,
                complete: false,
                usage: undefined
              };
            }
            break;

          case 'response.output_item.added':
            // New output item added (could be message, function call, or reasoning)
            if (event.item) {
              const item = event.item;

              // Handle reasoning item (GPT-5/o-series chain-of-thought)
              if (item.type === 'reasoning') {
                currentReasoningId = item.id;
                yield {
                  content: '',
                  complete: false,
                  reasoning: '',  // Initial empty to signal reasoning started
                  reasoningComplete: false,
                  reasoningId: item.id
                };
              }
              // Handle message with text content (only for messages, not function calls)
              else if (item.type === 'message' && item.content) {
                for (const content of item.content) {
                  if (content.type === 'text' && content.text) {
                    fullContent += content.text;
                    yield {
                      content: content.text,
                      complete: false,
                      usage: undefined
                    };
                  }
                }
              }
            }
            break;

          case 'response.content_part.added':
            // Content part added - check for reasoning_text
            if (event.part?.type === 'reasoning_text') {
              isInReasoningPart = true;
              if (event.part.text) {
                yield {
                  content: '',
                  complete: false,
                  reasoning: event.part.text,
                  reasoningComplete: false,
                  reasoningId: currentReasoningId || undefined
                };
              }
            }
            break;

          case 'response.content_part.delta':
            // Incremental content delta - check if we're in a reasoning part
            if (isInReasoningPart && event.delta) {
              yield {
                content: '',
                complete: false,
                reasoning: event.delta,
                reasoningComplete: false,
                reasoningId: currentReasoningId || undefined
              };
            }
            break;

          case 'response.content_part.done':
            // Content part finished
            if (event.part?.type === 'reasoning_text') {
              isInReasoningPart = false;
            }
            break;

          case 'response.output_item.done':
            // Output item complete - capture function calls or reasoning completion
            if (event.item) {
              const item = event.item;

              if (item.type === 'function_call') {
                const index = event.output_index || 0;

                toolCallsMap.set(index, {
                  id: item.call_id || item.id,
                  type: 'function',
                  function: {
                    name: item.name || '',
                    arguments: item.arguments || '{}'
                  }
                });
              } else if (item.type === 'reasoning') {
                // Reasoning item complete - capture encrypted_content for multi-turn
                currentReasoningEncryptedContent = item.encrypted_content || null;
                yield {
                  content: '',
                  complete: false,
                  reasoning: '',
                  reasoningComplete: true,
                  reasoningId: item.id,
                  reasoningEncryptedContent: currentReasoningEncryptedContent || undefined
                };
                currentReasoningId = null;
              }
            }
            break;

          case 'response.function_call_arguments.delta':
            // Arguments are streamed but we capture the complete call in output_item.done
            // No action needed here - just let the deltas flow
            break;

          // Handle reasoning summary events (GPT-5 sends these instead of reasoning_text)
          case 'response.reasoning_summary_text.delta':
            // Incremental reasoning summary text
            if (event.delta) {
              yield {
                content: '',
                complete: false,
                reasoning: event.delta,
                reasoningComplete: false,
                reasoningId: event.item_id || currentReasoningId || undefined
              };
            }
            break;

          case 'response.reasoning_summary_text.done':
            // Reasoning summary text complete - yield the full text
            if (event.text) {
              yield {
                content: '',
                complete: false,
                reasoning: '', // Already streamed via delta events
                reasoningComplete: true,
                reasoningId: event.item_id || currentReasoningId || undefined
              };
            }
            break;

          case 'response.reasoning_summary_part.done':
            // Reasoning summary part complete - mark reasoning as done
            yield {
              content: '',
              complete: false,
              reasoning: '',
              reasoningComplete: true,
              reasoningId: event.item_id || currentReasoningId || undefined
            };
            break;

          case 'response.done':
          case 'response.completed':
            // Final event - extract usage if available
            if (event.response?.usage) {
              usage = {
                promptTokens: event.response.usage.input_tokens || 0,
                completionTokens: event.response.usage.output_tokens || 0,
                totalTokens: event.response.usage.total_tokens || 0
              };
            }

            // Store response ID in metadata for continuation
            const metadata = currentResponseId ? { responseId: currentResponseId } : undefined;

            // Final yield with tool calls if any
            const toolCallsArray = Array.from(toolCallsMap.values());
            yield {
              content: '',
              complete: true,
              usage,
              toolCalls: toolCallsArray.length > 0 ? toolCallsArray : undefined,
              toolCallsReady: toolCallsArray.length > 0,
              metadata // Include response ID for tracking
            };

            break;

          default:
            // Ignore other event types
            break;
        }
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

    // TypeScript can't narrow the overloaded create() return type based on params,
    // so we cast to the expected non-streaming Response type
    const response = await this.client.responses.create(responseParams) as unknown as OpenAIResponse;

    if (!response.output || response.output.length === 0) {
      throw new Error('No output from OpenAI Responses API');
    }

    // Extract text content from output array
    let text = '';
    for (const item of response.output) {
      if (item.type === 'message' && item.content) {
        for (const content of item.content) {
          if (content.type === 'output_text') {
            text += content.text || '';
          }
        }
      }
    }

    const usage = response.usage ? {
      promptTokens: response.usage.input_tokens || 0,
      completionTokens: response.usage.output_tokens || 0,
      totalTokens: response.usage.total_tokens || 0
    } : undefined;

    return this.buildLLMResponse(
      text,
      model,
      usage,
      { responseId: response.id }, // Store response ID
      'stop'
    );
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
            console.warn('[OpenAI] Failed to parse web search tool result:', error);
          }
        }
      }

      return sources;
    } catch (error) {
      console.warn('[OpenAI] Failed to extract search sources:', error);
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
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: true,
      supportsImageGeneration: true,
      maxContextWindow: 2000000, // GPT-5 context window
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
      console.warn(`Failed to get pricing for model ${modelId}:`, error);
      return null;
    }
  }
}
