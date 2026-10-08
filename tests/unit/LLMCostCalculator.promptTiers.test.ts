import { ANTHROPIC_MODELS } from '../../src/services/llm/adapters/anthropic/AnthropicModels';
import { CostCalculator } from '../../src/services/llm/adapters/CostCalculator';
import { LLMCostCalculator } from '../../src/services/llm/utils/LLMCostCalculator';
import type { ModelSpec } from '../../src/services/llm/adapters/modelTypes';

const haiku = ANTHROPIC_MODELS.find(model => model.apiName === 'claude-haiku-5-5')!;

function cost(promptTokens: number, completionTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return LLMCostCalculator.calculateCost(
    { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cacheReadTokens, cacheWriteTokens },
    haiku.apiName,
    LLMCostCalculator.pricingFromSpec(haiku)
  );
}

describe('prompt-length pricing tiers', () => {
  it('uses base prices through 100,000 prompt tokens, then applies high prices to the whole request', () => {
    const base = cost(100_000, 10_000);
    expect(base?.rateInputPerMillion).toBe(0.10);
    expect(base?.rateOutputPerMillion).toBe(0.50);
    expect(base?.totalCost).toBeCloseTo(0.015, 9);

    const high = cost(100_001, 10_000);
    expect(high?.rateInputPerMillion).toBe(0.50);
    expect(high?.rateOutputPerMillion).toBe(2.50);
    expect(high?.totalCost).toBeCloseTo(0.0750005, 9);
    expect(cost(200_000, 10_000)?.totalCost).toBeCloseTo(0.125, 9);
  });

  it('counts cached input toward the threshold and applies the tier rates to each token class', () => {
    const base = cost(100_000, 2_000, 80_000, 10_000);
    expect(base?.cacheRead?.ratePerMillion).toBe(0.01);
    expect(base?.cacheWrite?.ratePerMillion).toBe(0.125);
    expect(base?.totalCost).toBeCloseTo(0.00405, 9);

    const high = cost(100_001, 2_000, 80_000, 10_000);
    expect(high?.cacheRead?.ratePerMillion).toBe(0.05);
    expect(high?.cacheWrite?.ratePerMillion).toBe(0.625);
    expect(high?.inputCost).toBeCloseTo(0.0152505, 9);
    expect(high?.outputCost).toBeCloseTo(0.005, 9);
    expect(high?.totalCost).toBeCloseTo(0.0202505, 9);
  });

  it('uses registry pricing on the chat cost path', () => {
    const breakdown = CostCalculator.calculateCostFromUsage('anthropic', haiku.apiName, {
      promptTokens: 100_001, completionTokens: 2_000, totalTokens: 102_001,
      cacheReadTokens: 80_000, cacheWriteTokens: 10_000
    });
    expect(breakdown?.totalCost).toBeCloseTo(0.0202505, 9);
    expect(breakdown?.costPerInputToken).toBeCloseTo(0.50 / 1_000_000, 12);
    expect(breakdown?.costPerOutputToken).toBeCloseTo(2.50 / 1_000_000, 12);
  });

  it('uses tier metadata rather than recognizing a particular model ID', () => {
    const changed: ModelSpec = {
      ...haiku,
      promptPricingTiers: [{
        minPromptTokens: 100_001,
        inputCostPerMillion: 1,
        outputCostPerMillion: 3,
        cacheReadCostPerMillion: 0.2,
        cacheWriteCostPerMillion: 0.4
      }]
    };
    const breakdown = LLMCostCalculator.calculateCost(
      { promptTokens: 100_001, completionTokens: 1_000, totalTokens: 101_001, cacheReadTokens: 90_000, cacheWriteTokens: 5_000 },
      'arbitrary-model-id',
      LLMCostCalculator.pricingFromSpec(changed)
    );
    expect(breakdown?.rateInputPerMillion).toBe(1);
    expect(breakdown?.rateOutputPerMillion).toBe(3);
    expect(breakdown?.cacheRead?.ratePerMillion).toBe(0.2);
    expect(breakdown?.cacheWrite?.ratePerMillion).toBe(0.4);
    expect(breakdown?.totalCost).toBeCloseTo(0.028001, 9);
  });
});
