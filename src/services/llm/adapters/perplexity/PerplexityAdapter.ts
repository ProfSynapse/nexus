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
  SearchResult
} from '../types';
import { PERPLEXITY_MODELS, PERPLEXITY_DEFAULT_MODEL } from './PerplexityModels';
import { WebSearchUtils } from '../../utils/WebSearchUtils';

export interface PerplexityOptions extends GenerateOptions {
  webSearch?: boolean;
  searchMode?: 'web' | 'academic' | 'sec';
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  searchContextSize?: 'low' | 'medium' | 'high';
}

interface PerplexityChatMessage {
  content?: string;
}

interface PerplexityChatChoice {
  message?: PerplexityChatMessage;
  finish_reason?: string;
}

interface PerplexityStreamChoice {
  delta?: {
    content?: string;
  };
  finish_reason?: string;
}

interface PerplexityStreamChunk {
  object?: string;
  choices?: PerplexityStreamChoice[];
  usage?: PerplexityChatResponse['usage'];
  citations?: string[];
  search_results?: PerplexitySearchResult[];
}

interface PerplexityChatResponse {
  choices: PerplexityChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  citations?: string[];
  search_results?: PerplexitySearchResult[];
}

interface PerplexitySearchResult {
  title?: string;
  url?: string;
  date?: string;
  last_updated?: string;
  snippet?: string;
  source?: string;
}

interface PerplexityRequestBody {
  model: string;
  messages: Array<Record<string, unknown>>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  search_mode?: 'web' | 'academic' | 'sec';
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  web_search_options?: {
    search_context_size: 'low' | 'medium' | 'high';
  };
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

      // Perplexity does not support native function calling.
      return await this.generateWithChatCompletions(prompt, options);
    } catch (error) {
      this.handleError(error, 'generation');
    }
  }

  /**
   * Generate streaming response using async generator.
   */
  async* generateStreamAsync(prompt: string, options?: PerplexityOptions): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      const requestBody = this.buildRequestBody(prompt, options, true);

      const nodeStream = await this.requestStream({
        url: `${this.baseUrl}/chat/completions`,
        operation: 'streaming generation',
        method: 'POST',
        headers: this.buildHeaders({
          'Authorization': `Bearer ${this.apiKey}`,
        }),
        body: JSON.stringify(requestBody),
        timeoutMs: 120_000
      });

      yield* this.processNodeStream(nodeStream, {
        debugLabel: 'Perplexity',
        extractContent: (parsed) => (parsed as PerplexityStreamChunk).choices?.[0]?.delta?.content || null,
        extractToolCalls: () => null,
        extractFinishReason: (parsed) => (parsed as PerplexityStreamChunk).choices?.[0]?.finish_reason || null,
        extractUsage: (parsed) => (parsed as PerplexityStreamChunk).usage,
        extractMetadata: (parsed) => this.extractResponseMetadata(parsed as PerplexityStreamChunk) || null
      });
    } catch (error) {
      console.error('[PerplexityAdapter] Streaming error:', error);
      throw error;
    }
  }

  listModels(): Promise<ModelInfo[]> {
    try {
      return Promise.resolve(PERPLEXITY_MODELS.map(model => ({
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
      })));
    } catch (error) {
      this.handleError(error, 'listing models');
      return Promise.resolve([]);
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
      maxContextWindow: 200000,
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
    const requestBody = this.buildRequestBody(prompt, options);

    const response = await this.request<PerplexityChatResponse>({
      url: `${this.baseUrl}/chat/completions`,
      operation: 'generation',
      method: 'POST',
      headers: this.buildHeaders({
        'Authorization': `Bearer ${this.apiKey}`,
      }),
      body: JSON.stringify(requestBody),
      timeoutMs: 60_000
    });

    this.assertOk(response, `Perplexity generation failed: HTTP ${response.status}`);

    const data = response.json as PerplexityChatResponse;
    const choice = data.choices[0];
    
    if (!choice) {
      throw new Error('No response from Perplexity');
    }
    
    const text = choice.message?.content || '';
    const usage = this.extractUsage(data);
    const rawFinishReason = choice.finish_reason || 'stop';

    const finishReason = this.mapFinishReason(rawFinishReason);
    const metadata = this.extractResponseMetadata(data);

    return this.buildLLMResponse(
      text,
      options?.model || this.currentModel,
      usage,
      metadata,
      finishReason
    );
  }

  // Private methods

  /**
   * Extract search results from Perplexity response
   */
  private extractPerplexitySources(searchResults: PerplexitySearchResult[]): SearchResult[] {
    try {
      if (!Array.isArray(searchResults)) {
        return [];
      }

      return searchResults
        .map(result => WebSearchUtils.validateSearchResult({
          title: result.title || 'Unknown Source',
          url: result.url,
          date: result.last_updated || result.date
        }))
        .filter((result: SearchResult | null): result is SearchResult => result !== null);
    } catch {
      return [];
    }
  }

  private extractResponseMetadata(
    data: { citations?: string[]; search_results?: PerplexitySearchResult[] } | undefined
  ): Record<string, unknown> | undefined {
    if (!data) {
      return undefined;
    }

    const webSearchResults = this.extractPerplexitySources(data.search_results || []);
    const citations = this.extractCitationUrls(data.citations, data.search_results || []);

    if (webSearchResults.length === 0 && citations.length === 0) {
      return undefined;
    }

    return {
      ...(webSearchResults.length > 0 ? { webSearchResults } : {}),
      ...(citations.length > 0 ? { citations } : {})
    };
  }

  private extractCitationUrls(
    citations: string[] | undefined,
    searchResults: PerplexitySearchResult[]
  ): string[] {
    const urls = new Set<string>();

    if (Array.isArray(citations)) {
      for (const citation of citations) {
        if (typeof citation === 'string' && citation.trim()) {
          urls.add(citation);
        }
      }
    }

    for (const result of searchResults) {
      if (typeof result.url === 'string' && result.url.trim()) {
        urls.add(result.url);
      }
    }

    return Array.from(urls);
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

  protected extractUsage(response: PerplexityChatResponse): TokenUsage | undefined {
    const usage = response?.usage;
    if (usage) {
      return {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0
      };
    }
    return undefined;
  }

  private buildRequestBody(
    prompt: string,
    options?: PerplexityOptions,
    stream = false
  ): PerplexityRequestBody {
    const model = options?.model || this.currentModel;
    const requestBody: PerplexityRequestBody = {
      model,
      messages: this.buildMessages(prompt, options?.systemPrompt),
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      stream,
      search_mode: options?.searchMode || 'web',
      web_search_options: {
        search_context_size: options?.searchContextSize || 'low'
      }
    };

    if (model === 'sonar-reasoning-pro') {
      requestBody.reasoning_effort = options?.reasoningEffort || 'medium';
    }

    return requestBody;
  }

  private getCostPer1kTokens(modelId: string): { input: number; output: number } | undefined {
    const model = PERPLEXITY_MODELS.find(m => m.apiName === modelId);
    if (!model) return undefined;
    
    return {
      input: model.inputCostPerMillion / 1000,
      output: model.outputCostPerMillion / 1000
    };
  }

  getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const costs = this.getCostPer1kTokens(modelId);
    if (!costs) return Promise.resolve(null);

    return Promise.resolve({
      rateInputPerMillion: costs.input * 1000,
      rateOutputPerMillion: costs.output * 1000,
      currency: 'USD'
    });
  }
}
