/**
 * LLM Cost Calculator Utility
 * Location: src/services/llm/utils/LLMCostCalculator.ts
 *
 * The one place cost arithmetic lives. Four token classes, four rates:
 *
 *   fresh input × input rate
 *   + cache reads × cache-read rate   (falls back to the input rate: no discount, never a guess)
 *   + cache writes × cache-write rate (falls back to the input rate)
 *   + output × output rate
 *
 * A price the provider itself reported (`usage.providerCost`) wins over the
 * arithmetic; the breakdown is then informational.
 *
 * Used by BaseAdapter (per-adapter pricing) and by CostCalculator on the chat
 * path (registry pricing) — both hand in a ModelPricing built from the same
 * ModelSpec fields.
 */

import { TokenUsage, CostDetails, ModelPricing } from '../adapters/types';
import type { ModelSpec } from '../adapters/modelTypes';

export class LLMCostCalculator {
  /**
   * Build the pricing view of a ModelSpec, including cache rates when the
   * spec declares them.
   */
  static pricingFromSpec(spec: Pick<ModelSpec, 'inputCostPerMillion' | 'outputCostPerMillion' | 'cacheReadCostPerMillion' | 'cacheWriteCostPerMillion'>): ModelPricing {
    const pricing: ModelPricing = {
      rateInputPerMillion: spec.inputCostPerMillion,
      rateOutputPerMillion: spec.outputCostPerMillion,
      currency: 'USD'
    };
    if (spec.cacheReadCostPerMillion !== undefined) {
      pricing.rateCacheReadPerMillion = spec.cacheReadCostPerMillion;
    }
    if (spec.cacheWriteCostPerMillion !== undefined) {
      pricing.rateCacheWritePerMillion = spec.cacheWriteCostPerMillion;
    }
    return pricing;
  }

  /**
   * Calculate cost from token usage and model pricing.
   */
  static calculateCost(
    usage: TokenUsage,
    _model: string,
    modelPricing: ModelPricing | null
  ): CostDetails | null {
    if (!modelPricing) {
      return null;
    }

    const cacheReadTokens = usage.cacheReadTokens ?? usage.cachedTokens ?? 0;
    const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
    const freshTokens = Math.max(0, usage.promptTokens - cacheReadTokens - cacheWriteTokens);

    const readRate = modelPricing.rateCacheReadPerMillion ?? modelPricing.rateInputPerMillion;
    const writeRate = modelPricing.rateCacheWritePerMillion ?? modelPricing.rateInputPerMillion;

    const freshCost = (freshTokens / 1_000_000) * modelPricing.rateInputPerMillion;
    const cacheReadCost = (cacheReadTokens / 1_000_000) * readRate;
    const cacheWriteCost = (cacheWriteTokens / 1_000_000) * writeRate;
    const inputCost = freshCost + cacheReadCost + cacheWriteCost;
    const outputCost = (usage.completionTokens / 1_000_000) * modelPricing.rateOutputPerMillion;

    const costDetails: CostDetails = {
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
      currency: modelPricing.currency || 'USD',
      rateInputPerMillion: modelPricing.rateInputPerMillion,
      rateOutputPerMillion: modelPricing.rateOutputPerMillion
    };

    if (cacheReadTokens > 0) {
      costDetails.cacheRead = { tokens: cacheReadTokens, cost: cacheReadCost, ratePerMillion: readRate };
      costDetails.cached = { tokens: cacheReadTokens, cost: cacheReadCost };
    }
    if (cacheWriteTokens > 0) {
      costDetails.cacheWrite = { tokens: cacheWriteTokens, cost: cacheWriteCost, ratePerMillion: writeRate };
    }

    if (usage.providerCost) {
      costDetails.totalCost = usage.providerCost.totalCost;
      costDetails.currency = usage.providerCost.currency || costDetails.currency;
      costDetails.providerReported = true;
    }

    return costDetails;
  }
}
