/**
 * The generateImage schema is written per setup: an agent only reads about
 * parameters, models and limits that the providers with a key can honour.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { GenerateImageTool } from '../../src/agents/promptManager/tools/generateImage';
import { DEFAULT_LLM_PROVIDER_SETTINGS, LLMProviderSettings } from '../../src/types/llm/ProviderTypes';
import { OPENAI_IMAGE_MODEL_SPECS } from '../../src/services/llm/adapters/openai/OpenAIImageAdapter';
import { getConfiguredImageProviders } from '../../src/services/llm/imageModelCapabilities';
import { jsonResponse } from './helpers/llmAdapterTestHarness';
import { PromptManagerAgent } from '../../src/agents/promptManager/promptManager';
import { ToolCliNormalizer } from '../../src/agents/toolManager/services/ToolCliNormalizer';
import { LLMSettingsNotifier } from '../../src/services/llm/LLMSettingsNotifier';

type Provider = 'google' | 'openai' | 'openrouter';

function settingsWith(providers: Provider[]): LLMProviderSettings {
  const settings = JSON.parse(JSON.stringify(DEFAULT_LLM_PROVIDER_SETTINGS)) as LLMProviderSettings;
  for (const provider of providers) {
    settings.providers[provider] = { ...settings.providers[provider], apiKey: `${provider}-key`, enabled: true };
  }
  return settings;
}

const vault = {
  getAbstractFileByPath: () => null,
  createFolder: async () => undefined,
  createBinary: async (path: string) => ({ path })
};

function toolFor(settings: LLMProviderSettings) {
  const tool = new GenerateImageTool({ vault: vault as never, llmSettings: settings });
  const schema = tool.getParameterSchema() as {
    properties: Record<string, { description?: string; enum?: string[]; maxItems?: number; pattern?: string }>;
  };
  return { tool, properties: schema.properties, text: `${tool.description} ${JSON.stringify(schema)}` };
}

const SVG_AND_GIF_PARAMS = ['outputFormat', 'frameCount', 'frameDurationMs'];

describe('generateImage schema follows the configured providers', () => {
  it('OpenRouter alone gets complexity, but no SVG, GIF or markup parameters', () => {
    const { tool, properties, text } = toolFor(settingsWith(['openrouter']));
    expect(properties.complexity.description).toContain('openrouter: ');
    for (const param of [...SVG_AND_GIF_PARAMS, 'markupImage']) {
      expect(properties).not.toHaveProperty(param);
    }
    expect(properties.savePath.pattern).not.toContain('svg');
    expect(tool.description).not.toMatch(/SVG|overlay/);
    expect(text).not.toMatch(/\bon openai\b|\bopenai:/);
  });

  it('OpenAI alone gets every 2.6 parameter, and no resolution it would ignore', () => {
    const { tool, properties } = toolFor(settingsWith(['openai']));
    for (const param of ['complexity', ...SVG_AND_GIF_PARAMS, 'markupImage']) {
      expect(properties).toHaveProperty(param);
    }
    expect(properties).not.toHaveProperty('imageSize');
    expect(properties.savePath.pattern).toContain('svg|gif');
    expect(properties.referenceImages.maxItems).toBe(16);
    expect(tool.description).toMatch(/^Generate images with OpenAI GPT Image\./);
    expect(tool.description).toContain('SVG and animated GIF');
  });

  it('Google alone reads nothing about OpenAI, OpenRouter or their parameters', () => {
    const { tool, properties, text } = toolFor(settingsWith(['google']));
    for (const param of ['complexity', ...SVG_AND_GIF_PARAMS, 'markupImage']) {
      expect(properties).not.toHaveProperty(param);
    }
    expect(properties.referenceImages.maxItems).toBe(14);
    expect(tool.description).toMatch(/^Generate images with Google Nano Banana\./);
    expect(text).not.toMatch(/gpt-|flux|seedream|openrouter/i);
  });

  it('with OpenAI and OpenRouter, SVG is offered only on the provider that has it', () => {
    const { properties } = toolFor(settingsWith(['openai', 'openrouter']));
    expect(properties.outputFormat.description).toContain('openai: ');
    expect(properties.outputFormat.description).not.toContain('openrouter');
    expect(properties.complexity.description).toContain('openai: ');
    expect(properties.complexity.description).toContain('openrouter: ');
  });

  it('never offers numberOfImages, because no adapter can honour it', () => {
    for (const keys of [['google'], ['openai'], ['openrouter'], ['google', 'openai', 'openrouter']] as Provider[][]) {
      expect(toolFor(settingsWith(keys)).properties).not.toHaveProperty('numberOfImages');
    }
  });

  it('offers only the aspect ratios the configured models accept', () => {
    const openAI = toolFor(settingsWith(['openai'])).properties.aspectRatio;
    expect(openAI.enum).toEqual(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);

    const google = toolFor(settingsWith(['google'])).properties.aspectRatio;
    expect(google.enum).toEqual(expect.arrayContaining(['1:4', '8:1']));
    expect(google.description).toMatch(/2:3.*on google: gemini-3-pro-image/);
  });

  it('a key on a disabled provider does not count', () => {
    const settings = settingsWith(['openai', 'openrouter']);
    settings.providers.openai.enabled = false;
    expect(getConfiguredImageProviders(settings)).toEqual(['openrouter']);
    expect(toolFor(settings).properties).not.toHaveProperty('outputFormat');
  });

  it('adding a key changes what the tool offers', () => {
    const { tool, properties } = toolFor(settingsWith(['openrouter']));
    expect(properties).not.toHaveProperty('outputFormat');
    tool.setLLMSettings(settingsWith(['openrouter', 'openai']));
    expect(tool.getParameterSchema().properties).toHaveProperty('outputFormat');
    expect(tool.description).toContain('SVG and animated GIF');
  });

  it('names models from the catalog, so a new entry with the flag is picked up', () => {
    const flagged = Object.entries(OPENAI_IMAGE_MODEL_SPECS).filter(([, spec]) => spec.features?.svgAndGif).map(([id]) => id);
    expect(flagged.length).toBeGreaterThan(0);
    const { properties } = toolFor(settingsWith(['openai']));
    for (const id of Object.keys(OPENAI_IMAGE_MODEL_SPECS)) {
      if (flagged.includes(id)) expect(properties.outputFormat.description).toContain(id);
      else expect(properties.outputFormat.description).not.toContain(`${id},`);
    }
  });
});

describe('generateImage tells the agent when a parameter cannot work here', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('says no configured provider offers SVG when only OpenRouter has a key', async () => {
    const request = jest.fn();
    __setRequestUrlMock(request as never);
    const { tool } = toolFor(settingsWith(['openrouter']));
    const result = await tool.execute({ prompt: 'x', provider: 'openrouter', model: 'gpt-image-2.6-flare', outputFormat: 'svg', savePath: 'a.svg' } as never);
    expect(result.success).toBe(false);
    expect(result.error).toContain('svg output is not available with the configured providers');
    expect(request).not.toHaveBeenCalled();
  });

  it('points to the right provider when both have keys', async () => {
    __setRequestUrlMock(jest.fn() as never);
    const { tool } = toolFor(settingsWith(['openai', 'openrouter']));
    const result = await tool.execute({ prompt: 'x', provider: 'openrouter', model: 'gpt-image-2.6-flare', outputFormat: 'gif', savePath: 'a.gif' } as never);
    expect(result.error).toMatch(/gif output is available on openai: .*gpt-image-2\.6-flare/);
  });

  it('reports a parameter the model ignored instead of dropping it silently', async () => {
    const png = Buffer.alloc(33);
    __setRequestUrlMock(async () => jsonResponse(200, { data: [{ b64_json: png.toString('base64') }], size: '1024x1024', usage: { input_tokens: 1, output_tokens: 1 } }));
    const { tool } = toolFor(settingsWith(['openai']));
    const result = await tool.execute({ prompt: 'x', provider: 'openai', model: 'gpt-image-2', complexity: 'low', savePath: 'a.png' } as never);
    expect(result.success).toBe(true);
    expect(result.data?.note).toMatch(/no complexity setting/);
  });
});

describe('what getTools shows, through agent registration', () => {
  function agentWith(settings: LLMProviderSettings) {
    const app = { vault: { ...vault, getName: () => 'test-vault' } };
    return new PromptManagerAgent(
      { settings: { llmProviders: settings, customPrompts: { prompts: [] } } } as never,
      { getLLMService: () => ({}), getSettings: () => settings } as never,
      {} as never,
      {} as never,
      app as never,
      app.vault as never,
      null
    );
  }

  /** The two views an agent reads: the discovery line, then the drilled-in arguments. */
  function discover(agent: PromptManagerAgent) {
    const normalizer = new ToolCliNormalizer(new Map([['promptManager', agent as never]]));
    const tool = agent.getTool('generateImage');
    if (!tool) return null;
    return {
      compact: normalizer.buildCliSchema('promptManager', tool as never, { compact: true }).description,
      flags: (normalizer.buildCliSchema('promptManager', tool as never).arguments ?? []).map(argument => argument.flag)
    };
  }

  it('a lazily registered tool describes the same setup as its schema', () => {
    const openRouterOnly = discover(agentWith(settingsWith(['openrouter'])));
    expect(openRouterOnly?.compact).toMatch(/^Generate images with any OpenRouter image model\./);
    expect(openRouterOnly?.compact).not.toContain('SVG');
    expect(openRouterOnly?.flags).toContain('--complexity');
    expect(openRouterOnly?.flags).not.toContain('--output-format');
    expect(openRouterOnly?.flags).not.toContain('--markup-image');

    const openAIOnly = discover(agentWith(settingsWith(['openai'])));
    expect(openAIOnly?.compact).toContain('SVG and animated GIF');
    expect(openAIOnly?.flags).toEqual(expect.arrayContaining(['--output-format', '--frame-count', '--markup-image']));
  });

  it('executePrompts follows a key change without a reload', () => {
    const agent = agentWith(settingsWith(['openrouter']));
    const imageParams = () => {
      const schema = agent.getTool('execute')?.getParameterSchema() as unknown as {
        properties: { prompts: { items: { properties: Record<string, unknown> } } };
      };
      return schema.properties.prompts.items.properties;
    };
    expect(imageParams()).not.toHaveProperty('outputFormat');
    LLMSettingsNotifier.notify(settingsWith(['openrouter', 'openai']));
    expect(imageParams()).toHaveProperty('outputFormat');
    LLMSettingsNotifier.notify(settingsWith(['openrouter']));
    expect(imageParams()).not.toHaveProperty('outputFormat');
  });

  it('generateVideo discovery follows the keys, both registered lazily and after a change', () => {
    const agent = agentWith(settingsWith(['google']));
    const normalizer = new ToolCliNormalizer(new Map([['promptManager', agent as never]]));
    const line = () => normalizer.buildCliSchema('promptManager', agent.getTool('generateVideo') as never, { compact: true }).description;
    expect(line()).toContain('Google Gemini Omni Flash');
    expect(line()).not.toContain('OpenRouter');

    LLMSettingsNotifier.notify(settingsWith(['openrouter']));
    expect(line()).toContain('OpenRouter video models');
    expect(line()).not.toContain('Omni');
  });

  it('keeps generateImage when a settings change leaves only an OpenAI key', () => {
    const agent = agentWith(settingsWith(['openai']));
    LLMSettingsNotifier.notify(settingsWith(['openai']));
    expect(agent.hasTool('generateImage')).toBe(true);
  });

  it('adding and removing a key updates discovery without a reload', () => {
    const agent = agentWith(settingsWith(['openrouter']));
    expect(discover(agent)?.flags).not.toContain('--output-format');

    LLMSettingsNotifier.notify(settingsWith(['openrouter', 'openai']));
    expect(discover(agent)?.flags).toContain('--output-format');
    expect(discover(agent)?.compact).toContain('SVG and animated GIF');

    LLMSettingsNotifier.notify(settingsWith(['openrouter']));
    expect(discover(agent)?.flags).not.toContain('--output-format');
    expect(discover(agent)?.compact).not.toContain('SVG');

    LLMSettingsNotifier.notify(settingsWith([]));
    expect(agent.hasTool('generateImage')).toBe(false);
  });
});
