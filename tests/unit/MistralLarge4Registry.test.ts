import { ModelRegistry, DEFAULT_MODELS } from '../../src/services/llm/adapters/ModelRegistry';
import { staticModelToModelInfo } from '../../src/services/llm/adapters/shared/StaticModelHelpers';

describe('Mistral Large 4 gateway registrations', () => {
  it('exposes OpenRouter’s published preview route and capabilities', () => {
    expect(ModelRegistry.findModel('openrouter', 'mistralai/mistral-large-4-0')).toEqual(expect.objectContaining({
      name: 'Mistral Large 4',
      contextWindow: 1048576,
      maxTokens: 262144,
      inputCostPerMillion: 0.68,
      outputCostPerMillion: 2.09,
      cacheReadCostPerMillion: 0.07,
      capabilities: {
        supportsJSON: true,
        supportsImages: true,
        supportsFunctions: true,
        supportsStreaming: true,
        supportsThinking: true
      }
    }));
  });

  it('exposes Requesty’s pinned route without inventing an output ceiling', () => {
    const model = ModelRegistry.findModel('requesty', 'mistral/mistral-large-4');
    expect(model).toEqual(expect.objectContaining({
      name: 'Mistral Large 4',
      contextWindow: 1000000,
      inputCostPerMillion: 0.68,
      outputCostPerMillion: 2.09,
      cacheReadCostPerMillion: 0.07,
      capabilities: {
        supportsJSON: true,
        supportsImages: true,
        supportsFunctions: true,
        supportsStreaming: true,
        supportsThinking: true
      }
    }));
    expect(model).not.toHaveProperty('maxTokens');
  });

  it('keeps the direct Mistral route and unknown output ceiling through model-info conversion', () => {
    const model = ModelRegistry.findModel('mistral', 'mistral-large-4');
    expect(model).toEqual(expect.objectContaining({
      name: 'Mistral Large 4 (Le Chonk, preview)',
      contextWindow: 1000000,
      inputCostPerMillion: 0.68,
      outputCostPerMillion: 2.09,
      cacheReadCostPerMillion: 0.07,
      capabilities: {
        supportsJSON: true,
        supportsImages: true,
        supportsFunctions: true,
        supportsStreaming: true,
        supportsThinking: true
      }
    }));
    expect(model).not.toHaveProperty('maxTokens');
    expect(staticModelToModelInfo(model!).maxOutputTokens).toBeUndefined();
    expect(ModelRegistry.toModelInfo(model!).maxOutputTokens).toBeUndefined();
  });

  it('keeps both gateway defaults unchanged', () => {
    expect(DEFAULT_MODELS.openrouter).toBe('openai/gpt-5.6-sol');
    expect(DEFAULT_MODELS.requesty).toBe('anthropic/claude-sonnet-4-6');
    expect(DEFAULT_MODELS.mistral).toBe('mistral-large-latest');
  });
});
