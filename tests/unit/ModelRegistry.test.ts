import { ModelRegistry, DEFAULT_MODELS } from '../../src/services/llm/adapters/ModelRegistry';

describe('ModelRegistry Claude Opus 4.8 models', () => {
  it('registers Claude Opus 4.8 for Anthropic', () => {
    expect(ModelRegistry.findModel('anthropic', 'claude-opus-4-8')).toEqual(expect.objectContaining({
      name: 'Claude Opus 4.8',
      contextWindow: 1000000,
      maxTokens: 128000,
      inputCostPerMillion: 5,
      outputCostPerMillion: 25,
      capabilities: expect.objectContaining({
        supportsJSON: true,
        supportsImages: true,
        supportsFunctions: true,
        supportsStreaming: true,
        supportsThinking: true
      })
    }));
  });

  it('registers Claude Opus 4.8 for OpenRouter with the provider namespace', () => {
    expect(ModelRegistry.findModel('openrouter', 'anthropic/claude-opus-4.8')).toEqual(expect.objectContaining({
      name: 'Claude Opus 4.8',
      contextWindow: 1000000,
      maxTokens: 128000,
      inputCostPerMillion: 5,
      outputCostPerMillion: 25,
      capabilities: expect.objectContaining({
        supportsJSON: true,
        supportsImages: true,
        supportsFunctions: true,
        supportsStreaming: true,
        supportsThinking: true
      })
    }));
  });
});

describe('ModelRegistry GPT-5.5 models', () => {
  it('registers GPT-5.5 and GPT-5.5 Pro for OpenAI', () => {
    expect(ModelRegistry.findModel('openai', 'gpt-5.5')).toEqual(expect.objectContaining({
      name: 'GPT-5.5',
      contextWindow: 1050000,
      maxTokens: 128000,
      inputCostPerMillion: 5,
      outputCostPerMillion: 30
    }));

    expect(ModelRegistry.findModel('openai', 'gpt-5.5-pro')).toEqual(expect.objectContaining({
      name: 'GPT-5.5 Pro',
      inputCostPerMillion: 30,
      outputCostPerMillion: 180
    }));
  });

  it('registers OpenRouter GPT-5.5 models with OpenRouter IDs', () => {
    expect(ModelRegistry.findModel('openrouter', 'openai/gpt-5.5')).toEqual(expect.objectContaining({
      name: 'GPT-5.5',
      contextWindow: 1050000,
      inputCostPerMillion: 5,
      outputCostPerMillion: 30
    }));

    expect(ModelRegistry.findModel('openrouter', 'openai/gpt-5.5-pro')).toEqual(expect.objectContaining({
      name: 'GPT-5.5 Pro',
      inputCostPerMillion: 30,
      outputCostPerMillion: 180
    }));
  });

  it('registers GPT-5.5 but not GPT-5.5 Pro for Codex', () => {
    expect(ModelRegistry.findModel('openai-codex', 'gpt-5.5')).toEqual(expect.objectContaining({
      name: 'GPT-5.5',
      contextWindow: 400000,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0
    }));

    expect(ModelRegistry.findModel('openai-codex', 'gpt-5.5-pro')).toBeUndefined();
  });

  it('uses GPT-5.5 as the default for the updated OpenAI providers', () => {
    expect(DEFAULT_MODELS.openai).toBe('gpt-5.5');
    expect(DEFAULT_MODELS.openrouter).toBe('openai/gpt-5.5');
    expect(DEFAULT_MODELS['openai-codex']).toBe('gpt-5.5');
  });
});

describe('ModelRegistry Gemini 3.5 Flash models', () => {
  it('registers Gemini 3.5 Flash for Google', () => {
    expect(ModelRegistry.findModel('google', 'gemini-3.5-flash')).toEqual(expect.objectContaining({
      name: 'Gemini 3.5 Flash',
      contextWindow: 1048576,
      maxTokens: 65536,
      inputCostPerMillion: 1.5,
      outputCostPerMillion: 9
    }));
  });

  it('registers Gemini 3.5 Flash for OpenRouter with the provider namespace', () => {
    expect(ModelRegistry.findModel('openrouter', 'google/gemini-3.5-flash')).toEqual(expect.objectContaining({
      name: 'Gemini 3.5 Flash',
      contextWindow: 1048576,
      maxTokens: 65536,
      inputCostPerMillion: 1.5,
      outputCostPerMillion: 9
    }));
  });
});
