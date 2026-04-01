/**
 * LLM Cost Calculator Utility
 * Location: src/services/llm/utils/LLMCostCalculator.ts
 *
 * Extracted from BaseAdapter.ts to follow Single Responsibility Principle.
 * Handles all cost calculation logic including caching discounts for different providers.
 *
 * Usage:
 * - Used by BaseAdapter and all provider adapters
 * - Calculates input/output costs based on token usage and model pricing
 * - Applies provider-specific caching discounts (OpenAI, Anthropic, Google)
 */

import { TokenUsage, CostDetails, ModelPricing } from '../adapters/types';

export class LLMCostCalculator {
  /**
   * Calculate cost based on token usage and model pricing
   * Supports caching discounts for providers that offer them
   */
  static calculateCost(
    usage: TokenUsage,
    model: string,
    modelPricing: ModelPricing | null
  ): CostDetails | null {
    if (!modelPricing) {
      return null;
    }

    // Determine caching discount rate based on provider and model
    const cachingDiscount = this.getCachingDiscount(model);

    // Calculate input cost with caching discount
    let inputCost = 0;
    let cachedCost = 0;

    if (usage.cachedTokens && usage.cachedTokens > 0 && cachingDiscount < 1.0) {
      // Split input tokens into cached and fresh
      const freshTokens = usage.promptTokens - usage.cachedTokens;
      const freshCost = (freshTokens / 1_000_000) * modelPricing.rateInputPerMillion;
      cachedCost = (usage.cachedTokens / 1_000_000) * modelPricing.rateInputPerMillion * cachingDiscount;
      inputCost = freshCost + cachedCost;

    } else {
      // No cached tokens, use standard pricing
      inputCost = (usage.promptTokens / 1_000_000) * modelPricing.rateInputPerMillion;
    }

    const outputCost = (usage.completionTokens / 1_000_000) * modelPricing.rateOutputPerMillion;
    const totalCost = inputCost + outputCost;

    const costDetails: CostDetails = {
      inputCost,
      outputCost,
      totalCost,
      currency: modelPricing.currency || 'USD',
      rateInputPerMillion: modelPricing.rateInputPerMillion,
      rateOutputPerMillion: modelPricing.rateOutputPerMillion
    };

    // Add cached token details if applicable
    if (usage.cachedTokens && usage.cachedTokens > 0) {
      costDetails.cached = {
        tokens: usage.cachedTokens,
        cost: cachedCost
      };
    }

    return costDetails;
  }

  /**
   * Get caching discount multiplier for a model
   * Returns the fraction of the original price (e.g., 0.1 = 90% off, 0.25 = 75% off)
   */
  static getCachingDiscount(model: string): number {
    // OpenAI pricing as of Oct 2025:
    // GPT-5 family: 90% off cached tokens (pay 10%)
    if (model.startsWith('gpt-5')) {
      return 0.1;
    }

    // GPT-5.2 family: 75% off cached tokens (pay 25%)
    if (model.startsWith('gpt-5.2')) {
      return 0.25;
    }

    // Anthropic Claude: 90% off cached tokens
    if (model.startsWith('claude')) {
      return 0.1;
    }

    // Google Gemini: 50% off cached tokens
    if (model.startsWith('gemini')) {
      return 0.5;
    }

    // Default: no caching discount
    return 1.0;
  }
}
