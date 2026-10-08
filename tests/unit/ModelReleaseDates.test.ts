import { AI_MODELS, ModelRegistry } from '../../src/services/llm/adapters/ModelRegistry';

describe('published model release dates', () => {
  it.each([
    ['anthropic', 'claude-haiku-5-5', '2026-10-07'],
    ['anthropic-claude-code', 'claude-haiku-5-5', '2026-10-07'],
    ['mistral', 'mistral-large-4', '2026-10-06'],
    ['requesty', 'mistral/mistral-large-4', '2026-10-06'],
    ['openrouter', 'mistralai/mistral-large-4-0', '2026-10-06'],
    ['openai', 'gpt-6.1-sol', '2026-09-29'],
    ['openai-codex', 'gpt-6.1-sol', '2026-09-29'],
    ['google', 'gemini-3.8-flash', '2026-09-02'],
    ['openrouter', 'deepseek/deepseek-v4-pro-0813', '2026-08-13'],
    ['deepseek', 'deepseek-v4-pro', '2026-08-13'],
    ['openrouter', 'qwen/qwen3.8-27b', '2026-08-14']
  ])('%s %s exposes %s through the registry', (provider, model, date) => {
    expect(ModelRegistry.findModel(provider, model)?.releaseDate).toBe(date);
  });

  it('keeps dates optional for undated or moving aliases', () => {
    expect(ModelRegistry.findModel('openrouter', '~deepseek/deepseek-pro-latest')?.releaseDate).toBeUndefined();
  });

  it('stores every declared date as an ISO calendar date', () => {
    for (const model of Object.values(AI_MODELS).flat()) {
      if (model.releaseDate !== undefined) {
        expect(model.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(new Date(`${model.releaseDate}T00:00:00Z`).toISOString().slice(0, 10)).toBe(model.releaseDate);
      }
    }
  });
});
