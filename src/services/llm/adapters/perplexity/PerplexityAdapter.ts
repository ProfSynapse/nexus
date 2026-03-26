/**
 * Perplexity AI Adapter with true streaming support
 * Supports Perplexity's Sonar models with web search and reasoning capabilities
 * Based on official Perplexity streaming documentation with SSE parsing
 */

import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  TokenUsage,
  SearchResult,
  Tool
} from '../types';
import { PERPLEXITY_MODELS, PERPLEXITY_DEFAULT_MODEL } from './PerplexityModels';
import { WebSearchUtils } from '../../utils/WebSearchUtils';

export interface PerplexityOptions extends GenerateOptions {
  webSearch?: boolean;
  searchMode?: 'web' | 'academic';
  reasoningEffort?: 'low' | 'medium' | 'high';
  searchContextSize?: 'low' | 'medium' | 'high';
}

interface PerplexityUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface PerplexityToolFunction {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
  arguments?: string;
}

interface PerplexityToolCall {
  id?: string;
  type?: string;
  function?: PerplexityToolFunction;
}

interface PerplexitySearchResult {
  title?: string;
  name?: string;
  url?: string;
  date?: string;
  timestamp?: string;
}

interface PerplexityRequestBody {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  tools?: ConvertedPerplexityTool[];
  stream?: boolean;
  extra: {
    search_mode: 'web' | 'academic';
    reasoning_effort: 'low' | 'medium' | 'high';
    web_search_options: {
      search_context_size: 'low' | 'medium' | 'high';
    };
  };
}

interface PerplexityStreamDelta {
  content?: string;
  tool_calls?: PerplexityToolCall[];
}

interface PerplexityStreamChoice {
  delta?: PerplexityStreamDelta;
  finish_reason?: string | null;
}

interface PerplexityFlatFunctionTool {
  type: 'function';
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
}

type PerplexityCompatibleTool = Tool | PerplexityFlatFunctionTool;

interface ConvertedPerplexityTool {
  type: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPerplexityUsage(value: unknown): value is PerplexityUsage {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.prompt_tokens === undefined || typeof value.prompt_tokens === 'number') &&
    (value.completion_tokens === undefined || typeof value.completion_tokens === 'number') &&
    (value.total_tokens === undefined || typeof value.total_tokens === 'number')
  );
}

function isPerplexityToolFunction(value: unknown): value is PerplexityToolFunction {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.name === undefined || typeof value.name === 'string') &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.parameters === undefined || isRecord(value.parameters)) &&
    (value.input_schema === undefined || isRecord(value.input_schema)) &&
    (value.arguments === undefined || typeof value.arguments === 'string')
  );
}

function isPerplexityToolCall(value: unknown): value is PerplexityToolCall {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.id === undefined || typeof value.id === 'string') &&
    (value.type === undefined || typeof value.type === 'string') &&
    (value.function === undefined || isPerplexityToolFunction(value.function))
  );
}

function isPerplexitySearchResult(value: unknown): value is PerplexitySearchResult {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.title === undefined || typeof value.title === 'string') &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.url === undefined || typeof value.url === 'string') &&
    (value.date === undefined || typeof value.date === 'string') &&
    (value.timestamp === undefined || typeof value.timestamp === 'string')
  );
}

function isPerplexityStreamDelta(value: unknown): value is PerplexityStreamDelta {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.content === undefined || typeof value.content === 'string') &&
    (value.tool_calls === undefined || (Array.isArray(value.tool_calls) && value.tool_calls.every(isPerplexityToolCall)))
  );
}

function isPerplexityStreamChoice(value: unknown): value is PerplexityStreamChoice {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.delta === undefined || isPerplexityStreamDelta(value.delta)) &&
    (value.finish_reason === undefined || value.finish_reason === null || typeof value.finish_reason === 'string')
  );
}

function getFirstStreamChoice(parsed: unknown): PerplexityStreamChoice | undefined {
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
    return undefined;
  }

  const firstChoice: unknown = parsed.choices.length > 0 ? parsed.choices[0] : undefined;
  return isPerplexityStreamChoice(firstChoice) ? firstChoice : undefined;
}

function getStreamUsage(parsed: unknown): PerplexityUsage | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }

  return isPerplexityUsage(parsed.usage) ? parsed.usage : undefined;
}

function getResponseUsage(response: unknown): PerplexityUsage | undefined {
  if (!isRecord(response)) {
    return undefined;
  }

  return isPerplexityUsage(response.usage) ? response.usage : undefined;
}

interface PerplexityChatMessage {
  content?: string;
  toolCalls?: PerplexityToolCall[];
}

interface PerplexityChatChoice {
  message?: PerplexityChatMessage;
  finish_reason?: string;
}

interface PerplexityChatResponse {
  choices: PerplexityChatChoice[];
  usage?: PerplexityUsage;
  search_results?: PerplexitySearchResult[];
}

export class PerplexityAdapter extends BaseAdapter {
  readonly name = 'perplexity';
  readonly baseUrl = 'https://api.perplexity.ai';

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || PERPLEXITY_DEFAULT_MODEL);
    this.initializeCache();
  }

  async generateUncached(prompt: string, options?: PerplexityOptions): Promise<LLMResponse> {
    try {
      // Validate web search support (Perplexity always supports web search)
      if (options?.webSearch) {
        WebSearchUtils.validateWebSearchRequest('perplexity', options.webSearch);
      }

      // Perplexity does not support native function calling
      // If tools are requested, proceed without tools

      // Use standard chat completions (Perplexity's strength is web search, not tool calling)
      return await this.generateWithChatCompletions(prompt, options);
    } catch (error) {
      this.handleError(error, 'generation');
    }
  }

  /**
   * Generate streaming response using async generator
   * Uses unified stream processing with automatic tool call accumulation
   */
  async* generateStreamAsync(prompt: string, options?: PerplexityOptions): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      const requestBody: PerplexityRequestBody = {
        model: options?.model || this.currentModel,
        messages: this.buildMessages(prompt, options?.systemPrompt),
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        top_p: options?.topP,
        presence_penalty: options?.presencePenalty,
        frequency_penalty: options?.frequencyPenalty,
        tools: options?.tools ? this.convertTools(options.tools) : undefined,
        stream: true,
        extra: {
          search_mode: options?.searchMode || 'web',
          reasoning_effort: options?.reasoningEffort || 'medium',
          web_search_options: {
            search_context_size: options?.searchContextSize || 'low'
          }
        }
      };

      const nodeStream = await this.requestStream({
        url: `${this.baseUrl}/chat/completions`,
        operation: 'streaming generation',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        timeoutMs: 120_000
      });

      yield* this.processNodeStream(nodeStream, {
        debugLabel: 'Perplexity',
        extractContent: (parsed) => getFirstStreamChoice(parsed)?.delta?.content ?? null,
        extractToolCalls: (parsed) => getFirstStreamChoice(parsed)?.delta?.tool_calls ?? null,
        extractFinishReason: (parsed) => getFirstStreamChoice(parsed)?.finish_reason ?? null,
        extractUsage: (parsed) => getStreamUsage(parsed) ?? null,
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });
    } catch (error) {
      console.error('[PerplexityAdapter] Streaming error:', error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      return PERPLEXITY_MODELS.map(model => ({
        id: model.apiName,
        name: model.name,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        supportsJSON: model.capabilities.supportsJSON,
        supportsImages: model.capabilities.supportsImages,
        supportsFunctions: model.capabilities.supportsFunctions,
        supportsStreaming: model.capabilities.supportsStreaming,
        supportsThinking: false,
        costPer1kTokens: {
          input: model.inputCostPerMillion / 1000,
          output: model.outputCostPerMillion / 1000
        },
        pricing: {
          inputPerMillion: model.inputCostPerMillion,
          outputPerMillion: model.outputCostPerMillion,
          currency: 'USD',
          lastUpdated: new Date().toISOString()
        }
      }));
    } catch (error) {
      this.handleError(error, 'listing models');
      return [];
    }
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      streamingMode: 'streaming',
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: false, // Perplexity does not support function calling
      supportsThinking: false,
      maxContextWindow: 127072,
      supportedFeatures: [
        'messages',
        'streaming',
        'web_search', // This is Perplexity's main strength
        'reasoning',
        'sonar_models',
        'academic_search',
        'real_time_information',
        'citations'
      ]
    };
  }

  /**
   * Generate using standard chat completions
   */
  private async generateWithChatCompletions(prompt: string, options?: PerplexityOptions): Promise<LLMResponse> {
    const model = options?.model || this.currentModel;

    const requestBody: PerplexityRequestBody = {
      model,
      messages: this.buildMessages(prompt, options?.systemPrompt),
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      presence_penalty: options?.presencePenalty,
      frequency_penalty: options?.frequencyPenalty,
      extra: {
        search_mode: options?.searchMode || 'web',
        reasoning_effort: options?.reasoningEffort || 'medium',
        web_search_options: {
          search_context_size: options?.searchContextSize || 'low'
        }
      }
    };

    // Add tools if provided
    if (options?.tools) {
      requestBody.tools = this.convertTools(options.tools);
    }

    const response = await this.request<PerplexityChatResponse>({
      url: `${this.baseUrl}/chat/completions`,
      operation: 'generation',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      timeoutMs: 60_000
    });

    this.assertOk(response, `Perplexity generation failed: HTTP ${response.status}`);

    const data = response.json as PerplexityChatResponse;
    const choice = data.choices[0];
    
    if (!choice) {
      throw new Error('No response from Perplexity');
    }
    
    let text = choice.message?.content || '';
    const usage = this.extractUsage(data);
    const rawFinishReason = choice.finish_reason || 'stop';

    // If tools were provided and we got tool calls, return placeholder text
    if (options?.tools && choice.message?.toolCalls && choice.message.toolCalls.length > 0) {
      text = text || '[AI requested tool calls but tool execution not available]';
    }

    // Extract and format web search results
    const webSearchResults = options?.webSearch || data.search_results
      ? this.extractPerplexitySources(data.search_results || [])
      : undefined;

    // Map finish reason to expected type
    const finishReason = this.mapFinishReason(rawFinishReason);

    return this.buildLLMResponse(
      text,
      model,
      usage,
      {
        provider: 'perplexity',
        searchResults: data.search_results, // Keep raw data for debugging
        searchMode: options?.searchMode,
        webSearchResults
      },
      finishReason
    );
  }

  // Private methods

  /**
   * Extract search results from Perplexity response
   */
  private extractPerplexitySources(searchResults: unknown): SearchResult[] {
    try {
      if (!Array.isArray(searchResults)) {
        return [];
      }

      return searchResults
        .filter(isPerplexitySearchResult)
        .map(result => WebSearchUtils.validateSearchResult({
          title: result.title || result.name || 'Unknown Source',
          url: result.url,
          date: result.date || result.timestamp
        }))
        .filter((result: SearchResult | null): result is SearchResult => result !== null);
    } catch {
      return [];
    }
  }

  private extractToolCalls(message: unknown): PerplexityToolCall[] {
    if (!isRecord(message) || !Array.isArray(message.toolCalls)) {
      return [];
    }

    return message.toolCalls.filter(isPerplexityToolCall);
  }

  private mapFinishReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    if (!reason) return 'stop';
    
    const reasonMap: Record<string, 'stop' | 'length' | 'tool_calls' | 'content_filter'> = {
      'stop': 'stop',
      'length': 'length',
      'tool_calls': 'tool_calls',
      'content_filter': 'content_filter'
    };
    return reasonMap[reason] || 'stop';
  }

  protected extractUsage(response: unknown): TokenUsage | undefined {
    const usage = getResponseUsage(response);
    if (usage) {
      return {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0
      };
    }
    return undefined;
  }

  private getCostPer1kTokens(modelId: string): { input: number; output: number } | undefined {
    const model = PERPLEXITY_MODELS.find(m => m.apiName === modelId);
    if (!model) return undefined;
    
    return {
      input: model.inputCostPerMillion / 1000,
      output: model.outputCostPerMillion / 1000
    };
  }

  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const costs = this.getCostPer1kTokens(modelId);
    if (!costs) return null;

    return {
      rateInputPerMillion: costs.input * 1000,
      rateOutputPerMillion: costs.output * 1000,
      currency: 'USD'
    };
  }

  private convertTools(tools: PerplexityCompatibleTool[]): ConvertedPerplexityTool[] {
    return tools.map((tool): ConvertedPerplexityTool => {
      if (tool.type === 'function') {
        // Handle both nested (Chat Completions) and flat (Responses API) formats
        const toolDef = this.getToolDefinition(tool);
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

  private getToolDefinition(tool: PerplexityCompatibleTool): PerplexityToolFunction {
    if ('function' in tool && tool.function) {
      return tool.function;
    }

    return tool;
  }
}
