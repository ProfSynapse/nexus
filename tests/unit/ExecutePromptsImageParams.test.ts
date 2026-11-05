/**
 * executePrompts is the other way to generate an image. Its schema has to follow
 * the same configured providers as generateImage, and every image option has to
 * survive the trip through the parser and ActionExecutor to that tool.
 */
import { ActionExecutor } from '../../src/agents/promptManager/tools/executePrompts/services/ActionExecutor';
import { ResultProcessor } from '../../src/agents/promptManager/tools/executePrompts/services/ResultProcessor';
import { ExecutePromptsTool } from '../../src/agents/promptManager/tools/executePrompts/executePrompts';
import { PromptParser } from '../../src/agents/promptManager/tools/executePrompts/utils/promptParser';
import type { ImagePromptConfig, ImageGenerationRequest } from '../../src/agents/promptManager/tools/executePrompts/types/executeTypes';
import { DEFAULT_LLM_PROVIDER_SETTINGS, LLMProviderSettings } from '../../src/types/llm/ProviderTypes';

type Provider = 'google' | 'openai' | 'openrouter';

function settingsWith(providers: Provider[]): LLMProviderSettings {
  const settings = JSON.parse(JSON.stringify(DEFAULT_LLM_PROVIDER_SETTINGS)) as LLMProviderSettings;
  for (const provider of providers) {
    settings.providers[provider] = { ...settings.providers[provider], apiKey: `${provider}-key`, enabled: true };
  }
  return settings;
}

function itemProperties(tool: ExecutePromptsTool) {
  const schema = tool.getParameterSchema() as unknown as {
    properties: { prompts: { items: { properties: Record<string, { enum?: string[]; description?: string; maxItems?: number; pattern?: string }> } } };
  };
  return schema.properties.prompts.items.properties;
}

function toolFor(settings: LLMProviderSettings) {
  return new ExecutePromptsTool(undefined, undefined, { getSettings: () => settings, getLLMService: () => null } as never);
}

describe('executePrompts image schema follows the configured providers', () => {
  it('has no image parameters when no image provider has a key', () => {
    const properties = itemProperties(toolFor(settingsWith([])));
    expect(properties.type.enum).toEqual(['text']);
    for (const param of ['savePath', 'aspectRatio', 'referenceImages', 'outputFormat', 'complexity']) {
      expect(properties).not.toHaveProperty(param);
    }
    expect(properties.provider.description).not.toContain('image');
  });

  it('OpenRouter alone gets complexity but no SVG, GIF or markup', () => {
    const properties = itemProperties(toolFor(settingsWith(['openrouter'])));
    expect(properties.type.enum).toEqual(['text', 'image']);
    expect(properties.complexity.description).toContain('openrouter: ');
    for (const param of ['outputFormat', 'frameCount', 'frameDurationMs', 'markupImage']) {
      expect(properties).not.toHaveProperty(param);
    }
    expect(properties.savePath.pattern).not.toContain('svg');
    expect(properties.model.description).not.toContain('openai:');
  });

  it('OpenAI alone gets the 2.6 options and its real limits, not the old static ones', () => {
    const properties = itemProperties(toolFor(settingsWith(['openai'])));
    expect(properties.outputFormat.description).toContain('gpt-image-2.6-flare');
    expect(properties.savePath.pattern).toContain('svg|gif');
    expect(properties.referenceImages.maxItems).toBe(16);
    expect(properties.aspectRatio.enum).toEqual(expect.arrayContaining(['21:9', '4:5']));
    expect(properties.aspectRatio).not.toHaveProperty('default');
    expect(properties).not.toHaveProperty('imageSize');
  });

  it('marks image parameters as image-only for an agent mixing text and image requests', () => {
    const properties = itemProperties(toolFor(settingsWith(['openai'])));
    for (const param of ['savePath', 'aspectRatio', 'complexity', 'outputFormat', 'frameCount', 'markupImage']) {
      expect(properties[param].description).toContain('Image requests only.');
    }
  });

  it('follows a key added after construction', () => {
    const tool = toolFor(settingsWith(['openrouter']));
    expect(itemProperties(tool)).not.toHaveProperty('outputFormat');
    tool.setImageSettings(settingsWith(['openrouter', 'openai']));
    expect(itemProperties(tool)).toHaveProperty('outputFormat');
  });
});

describe('executePrompts carries every image option to generateImage', () => {
  const options = {
    aspectRatio: '16:9',
    imageSize: '2K',
    complexity: 'low',
    outputFormat: 'gif',
    frameCount: 4,
    frameDurationMs: 120,
    markupImage: 'refs/circle.png'
  } as const;

  it('through the parser and the action executor', async () => {
    const request = { type: 'image', prompt: 'a cup', savePath: 'a.gif', provider: 'openai', model: 'gpt-image-2.6-flare', referenceImages: ['refs/a.png'], ...options };
    const [config] = new PromptParser().normalizePromptConfigs([request as unknown as ImageGenerationRequest]);
    expect(config).toMatchObject(options);

    const executeAgentTool = jest.fn(async () => ({ success: true, data: { imagePath: 'a.gif', note: 'heads up' } }));
    const executor = new ActionExecutor({ executeAgentTool } as never);
    const result = await executor.executeImageGenerationAction(config as ImagePromptConfig);

    expect(executeAgentTool).toHaveBeenCalledWith('promptManager', 'generateImage', expect.objectContaining(options));
    expect(result).toMatchObject({ success: true, imagePath: 'a.gif', note: 'heads up' });
  });

  it('keeps a note from generateImage in the public result', () => {
    const processor = new ResultProcessor();
    const lean = (processor as unknown as { toLeanResult: (r: unknown) => { note?: string; imagePath?: string } }).toLeanResult({
      type: 'image', success: true, imagePath: 'a.png', note: 'complexity ignored'
    });
    expect(lean).toEqual({ success: true, imagePath: 'a.png', note: 'complexity ignored' });
  });
});
