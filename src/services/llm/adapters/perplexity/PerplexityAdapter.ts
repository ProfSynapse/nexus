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
import { MCPToolExecution } from '../shared/ToolExecutionUtils';

export interface PerplexityOptions extends GenerateOptions {
  webSearch?: boolean;
  searchMode?: 'web' | 'academic';
  reasoningEffort?: 'low' | 'medium' | 'high';
  searchContextSize?: 'low' | 'medium' | 'high';
}

interface PerplexityChatMessage {
  content?: string;
  toolCalls?: any[];
}

interface PerplexityChatChoice {
  message?: PerplexityChatMessage;
  finish_reason?: string;
}

interface PerplexityChatResponse {
  choices: PerplexityChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  search_results?: any[];
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

      const model = options?.model || this.currentModel;

      // Perplexity does not support native function calling
      // If tools are requested, proceed without tools

      // Use standard chat completions (Perplexity's strength is web search, not tool calling)
      return await this.generateWithChatCompletions(prompt, options);
    } catch (error) {
      throw this.handleError(error, 'generation');
    }
  }

  /**
   * Generate streaming response using async generator
   * Uses unified stream processing with automatic tool call accumulation
   */
  async* generateStreamAsync(prompt: string, options?: PerplexityOptions): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      const requestBody = {
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

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // Use unified stream processing with automatic SSE parsing and tool call accumulation
      yield* this.processStream(response, {
        debugLabel: 'Perplexity',
        extractContent: (parsed) => parsed.choices?.[0]?.delta?.content || null,
        extractToolCalls: (parsed) => parsed.choices?.[0]?.delta?.tool_calls || null,
        extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null,
        extractUsage: (parsed) => parsed.usage || null
      });
    } catch (error) {
      console.error('[PerplexityAdapter] Streaming error:', error);
      throw error;
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
    
    const requestBody: any = {
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json() as PerplexityChatResponse;
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
  private extractPerplexitySources(searchResults: any[]): SearchResult[] {
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
    } catch (error) {
      return [];
    }
  }

  private extractToolCalls(message: any): any[] {
    return message?.toolCalls || [];
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

  protected extractUsage(response: any): TokenUsage | undefined {
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

  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const costs = this.getCostPer1kTokens(modelId);
    if (!costs) return null;

    return {
      rateInputPerMillion: costs.input * 1000,
      rateOutputPerMillion: costs.output * 1000,
      currency: 'USD'
    };
  }

  private convertTools(tools: any[]): any[] {
    return tools.map(tool => {
      if (tool.type === 'function') {
        // Handle both nested (Chat Completions) and flat (Responses API) formats
        const toolDef = tool.function || tool;
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