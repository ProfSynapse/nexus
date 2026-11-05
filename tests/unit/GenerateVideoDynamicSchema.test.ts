/**
 * The generateVideo schema is written per setup, as generateImage's is: an agent
 * only reads about models, options and limits that a provider with a key serves.
 */
import { GenerateVideoTool, buildGenerateVideoDescription } from '../../src/agents/promptManager/tools/generateVideo';
import { VideoGenerationService } from '../../src/services/video/VideoGenerationService';
import { DEFAULT_LLM_PROVIDER_SETTINGS, LLMProviderSettings } from '../../src/types/llm/ProviderTypes';
import { getVideoModel, listConfiguredVideoModels } from '../../src/services/llm/types/VideoTypes';

type Provider = 'google' | 'openrouter';

function settingsWith(providers: Provider[]): LLMProviderSettings {
  const settings = JSON.parse(JSON.stringify(DEFAULT_LLM_PROVIDER_SETTINGS)) as LLMProviderSettings;
  for (const provider of providers) {
    settings.providers[provider] = { ...settings.providers[provider], apiKey: `${provider}-key`, enabled: true };
  }
  return settings;
}

const vault = { getAbstractFileByPath: () => null, adapter: {} };

function toolFor(settings: LLMProviderSettings) {
  const tool = new GenerateVideoTool({ app: { vault } as never, vault: vault as never, llmSettings: settings });
  const schema = tool.getParameterSchema() as unknown as {
    properties: Record<string, { description?: string; enum?: string[] }>;
  };
  return { tool, properties: schema.properties, text: `${tool.description} ${JSON.stringify(schema)}` };
}

describe('generateVideo schema follows the configured providers', () => {
  it('Google alone reads only Omni rules', () => {
    const { tool, properties, text } = toolFor(settingsWith(['google']));
    expect(tool.description).toContain('Google Gemini Omni Flash');
    expect(tool.description).not.toContain('OpenRouter');
    expect(properties.provider.enum).toEqual(['google']);
    expect(properties.model.enum).toEqual(['gemini-omni-1.1-flash']);
    expect(properties.aspectRatio.enum).toEqual(['16:9', '9:16']);
    expect(properties.resolution.enum).toEqual(['360p', '720p', '1080p', '4k']);
    expect(properties.seconds.description).toContain('3-10s');
    expect(properties.generateAudio.description).toMatch(/Always on, and false is rejected, on google: gemini-omni-1\.1-flash/);
    expect(properties.negativePrompt.description).toMatch(/Added to the prompt/);
    expect(text).not.toMatch(/veo|kling|seedance|runway|grok|openrouter/i);
  });

  it('OpenRouter alone reads nothing about Omni, and no 360p it cannot make', () => {
    const { tool, properties, text } = toolFor(settingsWith(['openrouter']));
    expect(tool.description).toContain('OpenRouter video models');
    expect(tool.description).not.toContain('Omni');
    expect(properties.provider.enum).toEqual(['openrouter']);
    expect(properties.resolution.enum).not.toContain('360p');
    expect(properties.aspectRatio.enum).toContain('1:1');
    expect(properties.seconds.description).toContain('4, 6, 8s');
    expect(text).not.toMatch(/omni/i);
  });

  it('names only the models that take a negative prompt or reference image', () => {
    const { properties } = toolFor(settingsWith(['openrouter']));
    expect(properties.negativePrompt.description).toContain('google/veo-3.1');
    expect(properties.negativePrompt.description?.split('Added to the prompt')[1]).toContain('kwaivgi/kling-v3.0-pro');
    expect(properties.negativePrompt.description).not.toContain('runway/gen-4.5');
    expect(properties.negativePrompt.description).not.toContain('bytedance/seedance-2.5');
    expect(properties.referenceImage.description).toContain('bytedance/seedance-2.5');
    expect(properties.referenceImage.description).not.toContain('runway/gen-4.5');
  });

  it('a key on a disabled provider does not count, nor does a disabled model', () => {
    const disabled = settingsWith(['google', 'openrouter']);
    disabled.providers.google.enabled = false;
    expect(toolFor(disabled).properties.provider.enum).toEqual(['openrouter']);

    const modelOff = settingsWith(['openrouter']);
    modelOff.providers.openrouter.models = { 'runway/gen-4.5': { enabled: false } } as never;
    expect(toolFor(modelOff).properties.model.enum).not.toContain('runway/gen-4.5');
  });

  it('writes the description from what is configured', () => {
    expect(buildGenerateVideoDescription(settingsWith(['google', 'openrouter']))).toBe(
      'Generate MP4 video files in the vault from a text prompt, optionally guided by a reference image, using Google Gemini Omni Flash or OpenRouter video models.'
    );
    expect(buildGenerateVideoDescription(settingsWith([]))).toBe('Generate MP4 video files in the vault from a text prompt.');
    expect(listConfiguredVideoModels(null)).toEqual([]);
  });
});

describe('video catalog facts from the provider', () => {
  it.each([
    ['google/veo-3.1-fast', 'native'],
    ['kwaivgi/kling-v3.0-pro', 'appended'],
    ['bytedance/seedance-2.5', undefined],
    ['x-ai/grok-imagine-video-1.5', undefined],
    ['runway/gen-4.5', undefined]
  ])('%s negative prompt support follows the OpenRouter listing', (id, expected) => {
    expect(getVideoModel('openrouter', id)?.negativePrompt).toBe(expected);
  });
});

describe('generating with a negative prompt', () => {
  it('fails before any provider call on a model that has none', async () => {
    const service = new VideoGenerationService({ vault } as never, vault as never, { llmSettings: settingsWith(['openrouter']) });
    await expect(service.generate({
      prompt: 'a beach',
      provider: 'openrouter',
      model: 'runway/gen-4.5',
      outputPath: 'a.mp4',
      negativePrompt: 'people'
    } as never)).rejects.toThrow(/does not support a negative prompt/);
  });
});
