/**
 * Cost arithmetic with cache read/write classes and provider-reported prices.
 *
 * Replaces the prefix-guessed `getCachingDiscount(model)`, which (a) had a
 * dead branch — `gpt-5.2` could never match because `gpt-5` matched first,
 * silently billing 10% instead of 25% — and (b) knew nothing about cache
 * writes, which Anthropic charges at a premium. Rates now come from the
 * model spec; a missing rate means "charged at the input rate", never a guess.
 *
 * See docs/plans/turn-by-turn-history-and-provider-costing-plan.md (B3/B4).
 */

import { LLMCostCalculator } from '../../src/services/llm/utils/LLMCostCalculator';
import { CostCalculator } from '../../src/services/llm/adapters/CostCalculator';
import { TokenUsageExtractor } from '../../src/services/llm/utils/TokenUsageExtractor';
import { ANTHROPIC_MODELS } from '../../src/services/llm/adapters/anthropic/AnthropicModels';
import { OPENAI_MODELS } from '../../src/services/llm/adapters/openai/OpenAIModels';
import type { ModelPricing } from '../../src/services/llm/adapters/types';

const PRICING: ModelPricing = {
  rateInputPerMillion: 10,
  rateOutputPerMillion: 50,
  rateCacheReadPerMillion: 1,
  rateCacheWritePerMillion: 12.5,
  currency: 'USD'
};

describe('LLMCostCalculator.calculateCost — four token classes', () => {
  it('splits input into fresh / cache read / cache write at their own rates', () => {
    const cost = LLMCostCalculator.calculateCost(
      { promptTokens: 1_000_000, completionTokens: 100_000, totalTokens: 1_100_000, cacheReadTokens: 600_000, cacheWriteTokens: 100_000 },
      'any',
      PRICING
    );

    // fresh 300k × $10 = 3.0; read 600k × $1 = 0.6; write 100k × $12.5 = 1.25; out 100k × $50 = 5.0
    expect(cost?.inputCost).toBeCloseTo(4.85, 6);
    expect(cost?.outputCost).toBeCloseTo(5.0, 6);
    expect(cost?.totalCost).toBeCloseTo(9.85, 6);
    expect(cost?.cacheRead).toEqual({ tokens: 600_000, cost: expect.closeTo(0.6, 6), ratePerMillion: 1 });
    expect(cost?.cacheWrite).toEqual({ tokens: 100_000, cost: expect.closeTo(1.25, 6), ratePerMillion: 12.5 });
    expect(cost?.cached).toEqual({ tokens: 600_000, cost: expect.closeTo(0.6, 6) });
    expect(cost?.providerReported).toBeUndefined();
  });

  it('charges cache classes at the input rate when the spec declares no cache rate (no discount is assumed)', () => {
    const cost = LLMCostCalculator.calculateCost(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cacheReadTokens: 500_000 },
      'any',
      { rateInputPerMillion: 10, rateOutputPerMillion: 50, currency: 'USD' }
    );
    expect(cost?.inputCost).toBeCloseTo(10, 6);
    expect(cost?.cacheRead?.ratePerMillion).toBe(10);
  });

  it('honours the legacy cachedTokens alias', () => {
    const cost = LLMCostCalculator.calculateCost(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cachedTokens: 1_000_000 },
      'any',
      PRICING
    );
    expect(cost?.inputCost).toBeCloseTo(1, 6);
  });

  it('never bills negative fresh tokens when cache classes exceed promptTokens', () => {
    const cost = LLMCostCalculator.calculateCost(
      { promptTokens: 100, completionTokens: 0, totalTokens: 100, cacheReadTokens: 150 },
      'any',
      PRICING
    );
    expect(cost?.inputCost).toBeCloseTo(150 / 1e6, 12);
  });

  it('lets a provider-reported price win over the rate table', () => {
    const cost = LLMCostCalculator.calculateCost(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, providerCost: { totalCost: 0.42, currency: 'USD' } },
      'any',
      PRICING
    );
    expect(cost?.totalCost).toBe(0.42);
    expect(cost?.providerReported).toBe(true);
    // the breakdown stays informational
    expect(cost?.inputCost).toBeCloseTo(10, 6);
  });

  it('returns null without pricing', () => {
    expect(LLMCostCalculator.calculateCost({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }, 'any', null)).toBeNull();
  });
});

describe('model specs carry cache rates', () => {
  // Models whose published cache-read rate departs from the 0.1× structure.
  const PUBLISHED_ANTHROPIC_CACHE_READ: Record<string, number> = {
    'claude-opus-5-5': 0.2
  };

  it('every Anthropic model: read 0.1× input (unless published otherwise), write 1.25× input', () => {
    for (const spec of ANTHROPIC_MODELS) {
      const expectedRead = PUBLISHED_ANTHROPIC_CACHE_READ[spec.apiName] ?? spec.inputCostPerMillion * 0.1;
      expect(spec.cacheReadCostPerMillion).toBeCloseTo(expectedRead, 6);
      expect(spec.cacheWriteCostPerMillion).toBeCloseTo(spec.inputCostPerMillion * 1.25, 6);
    }
  });

  it('every OpenAI model: read 0.1× input, no write charge', () => {
    for (const spec of OPENAI_MODELS) {
      expect(spec.cacheReadCostPerMillion).toBeCloseTo(spec.inputCostPerMillion * 0.1, 6);
      expect(spec.cacheWriteCostPerMillion).toBeUndefined();
    }
  });

  it('regression: a gpt-5.2 cache hit is priced from its own spec, not a gpt-5 prefix match', () => {
    const spec = OPENAI_MODELS.find(m => m.apiName === 'gpt-5.2');
    expect(spec).toBeDefined();
    const pricing = LLMCostCalculator.pricingFromSpec(spec!);
    const cost = LLMCostCalculator.calculateCost(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cacheReadTokens: 1_000_000 },
      'gpt-5.2',
      pricing
    );
    expect(cost?.inputCost).toBeCloseTo(spec!.cacheReadCostPerMillion!, 6);
  });
});

describe('CostCalculator (chat path) uses the same arithmetic and the registry rates', () => {
  it('prices an Anthropic turn with cache read and write from the registry spec', () => {
    const spec = ANTHROPIC_MODELS.find(m => m.apiName === 'claude-opus-5')!;
    const breakdown = CostCalculator.calculateCostFromUsage('anthropic', 'claude-opus-5', {
      promptTokens: 10_000, completionTokens: 1_000, totalTokens: 11_000, cacheReadTokens: 8_000, cacheWriteTokens: 1_000
    });

    const expectedInput =
      (1_000 / 1e6) * spec.inputCostPerMillion +
      (8_000 / 1e6) * spec.cacheReadCostPerMillion! +
      (1_000 / 1e6) * spec.cacheWriteCostPerMillion!;
    expect(breakdown?.inputCost).toBeCloseTo(expectedInput, 9);
    expect(breakdown?.cacheRead?.tokens).toBe(8_000);
    expect(breakdown?.cacheWrite?.tokens).toBe(1_000);
    expect(breakdown?.tokenUsage.inputTokensDetails?.cachedTokens).toBe(8_000);
  });

  it('returns null for an unknown model', () => {
    expect(CostCalculator.calculateCostFromUsage('anthropic', 'nope', { promptTokens: 1, completionTokens: 1, totalTokens: 2 })).toBeNull();
  });
});

describe('TokenUsageExtractor.normalize — one shape for every provider', () => {
  it('OpenAI Responses: input_tokens_details.cached_tokens', () => {
    expect(TokenUsageExtractor.normalize({
      input_tokens: 1000, output_tokens: 50, total_tokens: 1050,
      input_tokens_details: { cached_tokens: 800 },
      output_tokens_details: { reasoning_tokens: 20 }
    })).toEqual({ promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cacheReadTokens: 800, cachedTokens: 800, reasoningTokens: 20 });
  });

  it('OpenAI chat completions / OpenRouter: prompt_tokens_details.cached_tokens and inline cost', () => {
    expect(TokenUsageExtractor.normalize({
      prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 800 },
      cost: 0.0123
    })).toEqual({ promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cacheReadTokens: 800, cachedTokens: 800, providerCost: { totalCost: 0.0123, currency: 'USD' } });
  });

  it('OpenRouter BYOK: cost is 0, so the upstream inference cost is the provider price', () => {
    // Verbatim shape from a live probe of openai/gpt-5.6-sol on a BYOK key.
    const usage = TokenUsageExtractor.normalize({
      prompt_tokens: 12, completion_tokens: 5, total_tokens: 17,
      cost: 0, is_byok: true,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0 },
      cost_details: { upstream_inference_cost: 0.000148, upstream_inference_prompt_cost: 0.000048, upstream_inference_completions_cost: 0.0001 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    expect(usage?.providerCost).toEqual({ totalCost: 0.000148, currency: 'USD' });
  });

  it('OpenRouter non-BYOK: a nonzero cost wins over cost_details, and cache_write_tokens maps', () => {
    const usage = TokenUsageExtractor.normalize({
      prompt_tokens: 91, completion_tokens: 41, total_tokens: 132,
      cost: 0.0007152, is_byok: false,
      prompt_tokens_details: { cached_tokens: 64, cache_write_tokens: 10 },
      cost_details: { upstream_inference_cost: 0.0007152 },
    });
    expect(usage).toMatchObject({ cacheReadTokens: 64, cacheWriteTokens: 10, providerCost: { totalCost: 0.0007152 } });
  });

  it('DeepSeek: prompt_cache_hit_tokens maps to cacheReadTokens', () => {
    const usage = TokenUsageExtractor.normalize({
      prompt_tokens: 100, completion_tokens: 5, total_tokens: 105,
      prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36,
    });
    expect(usage).toMatchObject({ promptTokens: 100, cacheReadTokens: 64 });
  });

  it('Anthropic: input_tokens is net of cache; promptTokens is grossed up', () => {
    expect(TokenUsageExtractor.normalize({
      input_tokens: 12, output_tokens: 40, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300
    })).toEqual({ promptTokens: 2312, completionTokens: 40, totalTokens: 2352, cacheReadTokens: 2000, cachedTokens: 2000, cacheWriteTokens: 300 });
  });

  it('Google: promptTokenCount is gross; cachedContentTokenCount and thoughtsTokenCount map', () => {
    expect(TokenUsageExtractor.normalize({
      promptTokenCount: 1000, candidatesTokenCount: 50, totalTokenCount: 1100, cachedContentTokenCount: 700, thoughtsTokenCount: 50
    })).toEqual({ promptTokens: 1000, completionTokens: 50, totalTokens: 1100, cacheReadTokens: 700, cachedTokens: 700, reasoningTokens: 50 });
  });

  it('already-normalized camelCase passes through unchanged', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15, cacheReadTokens: 4, cachedTokens: 4, cacheWriteTokens: 2, providerCost: { totalCost: 0.1, currency: 'USD' } };
    expect(TokenUsageExtractor.normalize(usage)).toEqual(usage);
  });

  it('returns undefined for non-objects and objects with no counts', () => {
    expect(TokenUsageExtractor.normalize(null)).toBeUndefined();
    expect(TokenUsageExtractor.normalize({ foo: 1 })).toBeUndefined();
  });
});
