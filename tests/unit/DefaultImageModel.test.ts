/**
 * The default image model is declared once (DEFAULT_IMAGE_MODEL) and every
 * fallback must agree with it: the shipped settings, both adapters, and the
 * first catalog entry the generateImage tool and the chat picker fall back to.
 */
import { DEFAULT_IMAGE_MODEL } from '../../src/services/llm/types/ImageTypes';
import { DEFAULT_LLM_PROVIDER_SETTINGS } from '../../src/types/llm/ProviderTypes';
import { GEMINI_IMAGE_MODEL_SPECS } from '../../src/services/llm/adapters/google/GeminiImageAdapter';
import { OPENROUTER_IMAGE_MODEL_SPECS } from '../../src/services/llm/adapters/openrouter/OpenRouterImageAdapter';

describe('default image model', () => {
  it('is Nano Banana 2.1, Google\'s recommended successor to gemini-3.1-flash-image', () => {
    expect(DEFAULT_IMAGE_MODEL).toBe('gemini-nano-banana-2.1');
  });

  it('is what a fresh install saves', () => {
    expect(DEFAULT_LLM_PROVIDER_SETTINGS.defaultImageModel).toEqual({ provider: 'google', model: DEFAULT_IMAGE_MODEL });
  });

  it('is the first catalog entry for Google direct and OpenRouter', () => {
    expect(Object.keys(GEMINI_IMAGE_MODEL_SPECS)[0]).toBe(DEFAULT_IMAGE_MODEL);
    expect(Object.keys(OPENROUTER_IMAGE_MODEL_SPECS)[0]).toBe(DEFAULT_IMAGE_MODEL);
  });
});
