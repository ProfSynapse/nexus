/**
 * Perplexity AI Adapter with true streaming support
 * Supports Perplexity's Sonar models with web search and reasoning capabilities
 * Based on official Perplexity streaming documentation with SSE parsing
 * Updated April 2026: fixed request body (no extra wrapper), removed dead tool code,
 * added all search params, gated reasoning_effort/stream_mode to sonar-reasoning-pro.
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
  searchContextSize?: 'low' | 'medium' | 'high';
  webSearchSearchType?: string;
  // Reasoning (sonar-reasoning-pro only)
  reasoningEffort?: 'low' | 'medium' | 'high' | 'minimal';
  streamMode?: string;
  // Search filters
  searchRecencyFilter?: 'hour' | 'day' | 'week' | 'month' | 'year';
  searchDomainFilter?: string[];
  searchAfterDateFilter?: string;
  searchBeforeDateFilter?: string;
  lastUpdatedAfterFilter?: string;
  lastUpdatedBeforeFilter?: string;
  enableSearchClassifier?: boolean;
  disableSearch?: boolean;
  returnRelatedQuestions?: boolean;
  returnImages?: boolean;
  searchLanguageFilter?: string;
  languagePreference?: string;
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
  choices?: PerplexityStreamChoice[];
  usage?: PerplexityChatResponse['usage'];
  citations?: string[];
  search_results?: PerplexitySearchResult[];
  related_questions?: string[];
  images?: unknown[];
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
  related_questions?: string[];
  images?: unknown[];
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
  messages: Array<Record<string, unknown>>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  // Search params (top-level per API spec)
  search_mode?: 'web' | 'academic' | 'sec';
  web_search_options?: {
    search_context_size?: 'low' | 'medium' | 'high';
    search_type?: string;
  };
  search_recency_filter?: 'hour' | 'day' | 'week' | 'month' | 'year';
  search_domain_filter?: string[];
  search_after_date_filter?: string;
  search_before_date_filter?: string;
  last_updated_after_filter?: string;
  last_updated_before_filter?: string;
  enable_search_classifier?: boolean;
  disable_search?: boolean;
  return_related_questions?: boolean;
  return_images?: boolean;
  search_language_filter?: string;
  language_preference?: string;
  // Reasoning — only valid for sonar-reasoning-pro
  reasoning_effort?: 'low' | 'medium' | 'high' | 'minimal';
  stream_mode?: string;
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
      if (options?.webSearch) {
        WebSearchUtils.validateWebSearchRequest('perplexity', options.webSearch);
      }
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
      const model = options?.model || this.currentModel;
      const isReasoningPro = model === 'sonar-reasoning-pro';

      const requestBody: PerplexityRequestBody = {
        model,
        messages: this.buildMessages(prompt, options?.systemPrompt),
        stream: true,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        top_p: options?.topP,
        search_mode: options?.searchMode,
        web_search_options: (options?.searchContextSize || options?.webSearchSearchType) ? {
          search_context_size: options?.searchContextSize,
          search_type: options?.webSearchSearchType
        } : undefined,
        search_recency_filter: options?.searchRecencyFilter,
        search_domain_filter: options?.searchDomainFilter,
        search_after_date_filter: options?.searchAfterDateFilter,
        search_before_date_filter: options?.searchBeforeDateFilter,
        last_updated_after_filter: options?.lastUpdatedAfterFilter,
        last_updated_before_filter: options?.lastUpdatedBeforeFilter,
        enable_search_classifier: options?.enableSearchClassifier,
        disable_search: options?.disableSearch,
        return_related_questions: options?.returnRelatedQuestions,
        return_images: options?.returnImages,
        search_language_filter: options?.searchLanguageFilter,
        language_preference: options?.languagePreference,
        // reasoning_effort and stream_mode are only valid for sonar-reasoning-pro
        reasoning_effort: isReasoningPro ? options?.reasoningEffort : undefined,
        stream_mode: isReasoningPro ? options?.streamMode : undefined
      };

      this.stripUndefined(requestBody as unknown as Record<string, unknown>);

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
        extractContent: (parsed) => (parsed as PerplexityStreamChunk).choices?.[0]?.delta?.content || null,
        extractToolCalls: () => null,
        extractFinishReason: (parsed) => (parsed as PerplexityStreamChunk).choices?.[0]?.finish_reason || null,
        extractUsage: (parsed) => (parsed as PerplexityStreamChunk).usage,
        extractMetadata: (parsed) => {
          const data = parsed as PerplexityStreamChunk;
          const meta: Record<string, unknown> = {};
          if (data.citations?.length) meta.perplexityCitations = data.citations;
          if (data.search_results?.length) meta.perplexitySearchResults = data.search_results;
          if (data.related_questions?.length) meta.perplexityRelatedQuestions = data.related_questions;
          if (data.images?.length) meta.perplexityImages = data.images;
          return Object.keys(meta).length > 0 ? meta : null;
        },
        accumulateToolCalls: false
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
      maxContextWindow: 127072,
      supportedFeatures: [
        'messages',
        'streaming',
        'web_search',
        'reasoning',
        'sonar_models',
        'academic_search',
        'real_time_information',
        'citations'
      ]
    };
  }

  /**
   * Generate using standard chat completions (non-streaming path)
   */
  private async generateWithChatCompletions(prompt: string, options?: PerplexityOptions): Promise<LLMResponse> {
    const model = options?.model || this.currentModel;
    const isReasoningPro = model === 'sonar-reasoning-pro';

    const requestBody: PerplexityRequestBody = {
      model,
      messages: this.buildMessages(prompt, options?.systemPrompt),
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      search_mode: options?.searchMode,
      web_search_options: (options?.searchContextSize || options?.webSearchSearchType) ? {
        search_context_size: options?.searchContextSize,
        search_type: options?.webSearchSearchType
      } : undefined,
      search_recency_filter: options?.searchRecencyFilter,
      search_domain_filter: options?.searchDomainFilter,
      search_after_date_filter: options?.searchAfterDateFilter,
      search_before_date_filter: options?.searchBeforeDateFilter,
      last_updated_after_filter: options?.lastUpdatedAfterFilter,
      last_updated_before_filter: options?.lastUpdatedBeforeFilter,
      enable_search_classifier: options?.enableSearchClassifier,
      disable_search: options?.disableSearch,
      return_related_questions: options?.returnRelatedQuestions,
      return_images: options?.returnImages,
      search_language_filter: options?.searchLanguageFilter,
      language_preference: options?.languagePreference,
      reasoning_effort: isReasoningPro ? options?.reasoningEffort : undefined,
      stream_mode: isReasoningPro ? options?.streamMode : undefined
    };

    this.stripUndefined(requestBody as unknown as Record<string, unknown>);

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

    const text = choice.message?.content || '';
    const usage = this.extractUsage(data);
    const finishReason = this.mapFinishReason(choice.finish_reason || 'stop');

    const webSearchResults = options?.webSearch || data.search_results
      ? this.extractPerplexitySources(data.search_results || [])
      : undefined;

    const responseMeta: Record<string, unknown> = {
      provider: 'perplexity',
      searchResults: data.search_results,
      searchMode: options?.searchMode,
      webSearchResults
    };
    if (data.citations?.length) responseMeta.perplexityCitations = data.citations;
    if (data.search_results?.length) responseMeta.perplexitySearchResults = data.search_results;
    if (data.related_questions?.length) responseMeta.perplexityRelatedQuestions = data.related_questions;
    if (data.images?.length) responseMeta.perplexityImages = data.images;

    return this.buildLLMResponse(text, model, usage, responseMeta, finishReason);
  }

  // Private methods

  /**
   * Remove undefined keys from an object before JSON serialisation so the
   * Perplexity API never receives fields that aren't explicitly set.
   */
  private stripUndefined(obj: Record<string, unknown>): void {
    Object.keys(obj).forEach(key => {
      if (obj[key] === undefined) {
        delete obj[key];
      }
    });
  }

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
          title: result.title || result.name || 'Unknown Source',
          url: result.url,
          date: result.date || result.timestamp
        }))
        .filter((result: SearchResult | null): result is SearchResult => result !== null);
    } catch {
      return [];
    }
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
