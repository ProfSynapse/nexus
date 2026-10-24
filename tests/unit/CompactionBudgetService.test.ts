import { CompactionBudgetService } from '../../src/services/chat/CompactionBudgetService';

describe('compaction state budget', () => {
  it.each([[4096, 409], [8192, 819], [128000, 12800]])(
    'uses ten percent of the selected %s-token window', (contextWindow, expected) => {
      expect(CompactionBudgetService.getStateBudget({ contextWindow })).toBe(expected);
    }
  );

  it('respects a provider output allowance smaller than the context percentage', () => {
    expect(CompactionBudgetService.getStateBudget({ contextWindow: 128000, maxOutputTokens: 4096 })).toBe(4096);
  });

  it('leaves room for instructions, retained turns and a response on a small local model', () => {
    const budget = CompactionBudgetService.getStateBudget({
      contextWindow: 4096, fixedPromptTokens: 3000, retainedTokens: 100,
    });
    expect(budget).toBeLessThan(409);
    expect(budget + 3000 + 100 + 409).toBeLessThan(4096 * 0.9);
  });

  it('rejects unknown windows and exhausted space instead of inventing a cloud-sized budget', () => {
    expect(() => CompactionBudgetService.getStateBudget({ contextWindow: Number.NaN })).toThrow();
    expect(() => CompactionBudgetService.getStateBudget({ contextWindow: 4096, fixedPromptTokens: 4000 })).toThrow();
  });
});
