/**
 * Cost Calculation and Token Counting System
 * 
 * This module provides comprehensive cost calculation with proper token counting
 * using provider APIs when available, with fallback tokenization for accuracy.
 * 
 * Features:
 * - Provider-specific token counting APIs
 * - Fallback tokenization for all providers
 * - Detailed cost breakdown and tracking
 * - Usage analytics and reporting
 */

import { ModelRegistry } from './ModelRegistry';

/**
 * OpenAI tokenize API response
 */
interface OpenAITokenizeResponse {
  token_count?: number;
}

/**
 * Google countTokens API response
 */
interface GoogleCountTokensResponse {
  totalTokens?: number;
}

/**
 * Anthropic count tokens API response
 */
interface AnthropicCountTokensResponse {
  input_tokens?: number;
}

/**
 * OpenAI-style usage object (used by OpenAI, OpenRouter, Requesty)
 */
interface OpenAIUsage {
  input_tokens?: number;
  prompt_tokens?: number;
  output_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: {
    cachedTokens?: number;
    audioTokens?: number;
    textTokens?: number;
  };
  output_tokens_details?: {
    reasoningTokens?: number;
    audioTokens?: number;
    textTokens?: number;
  };
}

/**
 * Google Gemini usage metadata
 */
interface GoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

/**
 * Anthropic Claude usage object
 */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/**
 * Generic provider response that might contain usage information
 */
interface ProviderResponse {
  usage?: OpenAIUsage | AnthropicUsage;
  usageMetadata?: GoogleUsageMetadata;
}

/**
 * Detailed token usage information from provider APIs or fallback tokenization
 */
export interface DetailedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokensDetails?: {
    cachedTokens?: number;
    audioTokens?: number;
    textTokens?: number;
  };
  outputTokensDetails?: {
    reasoningTokens?: number;
    audioTokens?: number;
    textTokens?: number;
  };
  source: 'provider_api' | 'fallback_tokenizer';
}

/**
 * Detailed cost breakdown
 */
export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
  model: string;
  provider: string;
  tokenUsage: DetailedTokenUsage;
  costPerInputToken: number;
  costPerOutputToken: number;
  timestamp: string;
}

/**
 * Cost tracking for analytics
 */
export interface CostTracker {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  costByProvider: Record<string, number>;
  costByModel: Record<string, number>;
  averageCostPerRequest: number;
  currency: string;
  lastUpdated: string;
}

/**
 * Provider-specific token counting functions
 */
export class TokenCounter {
  /**
   * Count tokens using OpenAI's token counting API
   */
  static async countTokensOpenAI(text: string, model: string): Promise<number> {
    try {
      // Use OpenAI's token counting endpoint if available
      const response = await fetch('https://api.openai.com/v1/tokenize', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model,
          text: text
        })
      });

      if (response.ok) {
        const data = await response.json() as OpenAITokenizeResponse;
        return data.token_count || 0;
      }
    } catch (error) {
    }

    return this.fallbackTokenCount(text);
  }

  /**
   * Count tokens using Google's token counting API
   */
  static async countTokensGoogle(text: string, model: string): Promise<number> {
    try {
      // Google's countTokens API
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens?key=${process.env.GOOGLE_API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: text }]
          }]
        })
      });

      if (response.ok) {
        const data = await response.json() as GoogleCountTokensResponse;
        return data.totalTokens || 0;
      }
    } catch (error) {
    }

    return this.fallbackTokenCount(text);
  }

  /**
   * Count tokens using Anthropic's token counting API
   */
  static async countTokensAnthropic(text: string, model: string): Promise<number> {
    try {
      // Anthropic's count tokens endpoint
      const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY!,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: text }]
        })
      });

      if (response.ok) {
        const data = await response.json() as AnthropicCountTokensResponse;
        return data.input_tokens || 0;
      }
    } catch (error) {
    }

    return this.fallbackTokenCount(text);
  }

  /**
   * Fallback token counting using simple heuristics
   * Based on OpenAI's general rule: ~4 characters per token for English text
   */
  static fallbackTokenCount(text: string): number {
    if (!text) return 0;
    
    // More sophisticated estimation
    const words = text.split(/\s+/).length;
    const chars = text.length;
    
    // Estimate based on multiple factors
    const charBasedEstimate = Math.ceil(chars / 4);
    const wordBasedEstimate = Math.ceil(words * 1.3); // ~1.3 tokens per word on average
    
    // Use the more conservative (higher) estimate
    return Math.max(charBasedEstimate, wordBasedEstimate);
  }

  /**
   * Count tokens for any provider with fallback
   */
  static async countTokens(text: string, provider: string, model: string): Promise<DetailedTokenUsage> {
    let tokenCount = 0;
    let source: 'provider_api' | 'fallback_tokenizer' = 'fallback_tokenizer';

    try {
      switch (provider) {
        case 'openai':
          tokenCount = await this.countTokensOpenAI(text, model);
          source = 'provider_api';
          break;
        case 'google':
          tokenCount = await this.countTokensGoogle(text, model);
          source = 'provider_api';
          break;
        case 'anthropic':
          tokenCount = await this.countTokensAnthropic(text, model);
          source = 'provider_api';
          break;
        default:
          tokenCount = this.fallbackTokenCount(text);
          break;
      }
    } catch (error) {
      tokenCount = this.fallbackTokenCount(text);
    }

    return {
      inputTokens: tokenCount,
      outputTokens: 0,
      totalTokens: tokenCount,
      source
    };
  }
}

/**
 * Main cost calculation engine
 */
export class CostCalculator {
  /**
   * Calculate cost from token usage and model pricing
   */
  static calculateCost(
    provider: string,
    model: string,
    tokenUsage: DetailedTokenUsage
  ): CostBreakdown | null {
    const modelSpec = ModelRegistry.findModel(provider, model);
    if (!modelSpec) {
      return null;
    }

    const costPerInputToken = modelSpec.inputCostPerMillion / 1_000_000;
    const costPerOutputToken = modelSpec.outputCostPerMillion / 1_000_000;

    const inputCost = tokenUsage.inputTokens * costPerInputToken;
    const outputCost = tokenUsage.outputTokens * costPerOutputToken;
    const totalCost = inputCost + outputCost;

    return {
      inputCost,
      outputCost,
      totalCost,
      currency: 'USD',
      model,
      provider,
      tokenUsage,
      costPerInputToken,
      costPerOutputToken,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Type guard to check if usage object is OpenAI format
   */
  private static isOpenAIUsage(usage: OpenAIUsage | AnthropicUsage): usage is OpenAIUsage {
    return 'prompt_tokens' in usage || 'completion_tokens' in usage || 'total_tokens' in usage;
  }

  /**
   * Type guard to check if usage object is Anthropic format
   */
  private static isAnthropicUsage(usage: OpenAIUsage | AnthropicUsage): usage is AnthropicUsage {
    return !this.isOpenAIUsage(usage);
  }

  /**
   * Extract token usage from provider response objects
   */
  static extractTokenUsage(response: ProviderResponse, provider: string): DetailedTokenUsage | null {
    try {
      switch (provider) {
        case 'openai':
          // OpenAI Responses API and Chat Completions format
          if (response.usage && this.isOpenAIUsage(response.usage)) {
            return {
              inputTokens: response.usage.input_tokens || response.usage.prompt_tokens || 0,
              outputTokens: response.usage.output_tokens || response.usage.completion_tokens || 0,
              totalTokens: response.usage.total_tokens || 0,
              inputTokensDetails: response.usage.input_tokens_details,
              outputTokensDetails: response.usage.output_tokens_details,
              source: 'provider_api'
            };
          }
          break;

        case 'google':
          // Google Gemini format
          if (response.usageMetadata) {
            return {
              inputTokens: response.usageMetadata.promptTokenCount || 0,
              outputTokens: response.usageMetadata.candidatesTokenCount || 0,
              totalTokens: response.usageMetadata.totalTokenCount || 0,
              source: 'provider_api'
            };
          }
          break;

        case 'anthropic':
          // Anthropic Claude format
          if (response.usage && this.isAnthropicUsage(response.usage)) {
            return {
              inputTokens: response.usage.input_tokens || 0,
              outputTokens: response.usage.output_tokens || 0,
              totalTokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0),
              source: 'provider_api'
            };
          }
          break;

        case 'openrouter':
        case 'requesty':
          // OpenRouter/Requesty typically pass through OpenAI format
          if (response.usage && this.isOpenAIUsage(response.usage)) {
            return {
              inputTokens: response.usage.prompt_tokens || 0,
              outputTokens: response.usage.completion_tokens || 0,
              totalTokens: response.usage.total_tokens || 0,
              source: 'provider_api'
            };
          }
          break;
      }
    } catch (error) {
    }

    return null;
  }

  /**
   * Calculate cost with automatic token counting if usage not provided
   */
  static async calculateCostWithTokenCounting(
    provider: string,
    model: string,
    inputText: string,
    outputText: string,
    providedUsage?: DetailedTokenUsage
  ): Promise<CostBreakdown | null> {
    let tokenUsage: DetailedTokenUsage;

    if (providedUsage) {
      tokenUsage = providedUsage;
    } else {
      // Count tokens for input and output
      const inputUsage = await TokenCounter.countTokens(inputText, provider, model);
      const outputUsage = await TokenCounter.countTokens(outputText, provider, model);
      
      tokenUsage = {
        inputTokens: inputUsage.inputTokens,
        outputTokens: outputUsage.inputTokens, // Output counting uses same method
        totalTokens: inputUsage.inputTokens + outputUsage.inputTokens,
        source: inputUsage.source
      };
    }

    return this.calculateCost(provider, model, tokenUsage);
  }

  /**
   * Compare costs across multiple providers/models
   */
  static compareCosts(
    providers: Array<{ provider: string; model: string }>,
    tokenUsage: DetailedTokenUsage
  ): Array<CostBreakdown> {
    return providers
      .map(({ provider, model }) => this.calculateCost(provider, model, tokenUsage))
      .filter(Boolean)
      .sort((a, b) => a!.totalCost - b!.totalCost) as Array<CostBreakdown>;
  }
}

/**
 * Cost tracking and analytics
 */
export class CostAnalyzer {
  private tracker: CostTracker = {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    costByProvider: {},
    costByModel: {},
    averageCostPerRequest: 0,
    currency: 'USD',
    lastUpdated: new Date().toISOString()
  };

  addUsage(costBreakdown: CostBreakdown): void {
    this.tracker.totalRequests++;
    this.tracker.totalInputTokens += costBreakdown.tokenUsage.inputTokens;
    this.tracker.totalOutputTokens += costBreakdown.tokenUsage.outputTokens;
    this.tracker.totalCost += costBreakdown.totalCost;
    
    this.tracker.costByProvider[costBreakdown.provider] = 
      (this.tracker.costByProvider[costBreakdown.provider] || 0) + costBreakdown.totalCost;
    
    const modelKey = `${costBreakdown.provider}/${costBreakdown.model}`;
    this.tracker.costByModel[modelKey] = 
      (this.tracker.costByModel[modelKey] || 0) + costBreakdown.totalCost;
    
    this.tracker.averageCostPerRequest = this.tracker.totalCost / this.tracker.totalRequests;
    this.tracker.lastUpdated = new Date().toISOString();
  }

  getReport(): CostTracker {
    return { ...this.tracker };
  }

  getMostExpensive(): { provider: string; model: string; cost: number } | null {
    const entries = Object.entries(this.tracker.costByModel);
    if (entries.length === 0) return null;

    const [model, cost] = entries.reduce((max, entry) => 
      entry[1] > max[1] ? entry : max
    );

    const [provider, modelName] = model.split('/');
    return { provider: provider || 'unknown', model: modelName || model, cost };
  }

  getCheapest(): { provider: string; model: string; cost: number } | null {
    const entries = Object.entries(this.tracker.costByModel);
    if (entries.length === 0) return null;

    const [model, cost] = entries.reduce((min, entry) => 
      entry[1] < min[1] ? entry : min
    );

    const [provider, modelName] = model.split('/');
    return { provider: provider || 'unknown', model: modelName || model, cost };
  }

  getCostByProvider(): Record<string, { cost: number; percentage: number }> {
    const result: Record<string, { cost: number; percentage: number }> = {};
    
    for (const [provider, cost] of Object.entries(this.tracker.costByProvider)) {
      result[provider] = {
        cost,
        percentage: this.tracker.totalCost > 0 ? (cost / this.tracker.totalCost) * 100 : 0
      };
    }
    
    return result;
  }

  reset(): void {
    this.tracker = {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      costByProvider: {},
      costByModel: {},
      averageCostPerRequest: 0,
      currency: 'USD',
      lastUpdated: new Date().toISOString()
    };
  }

  exportData(): string {
    return JSON.stringify(this.tracker, null, 2);
  }

  importData(data: string): void {
    try {
      const imported = JSON.parse(data);
      this.tracker = { ...this.tracker, ...imported };
    } catch (error) {
      console.error('Failed to import cost tracking data:', error);
    }
  }
}

/**
 * Global cost analyzer instance for easy access
 */
export const globalCostAnalyzer = new CostAnalyzer();