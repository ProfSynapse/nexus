/**
 * OpenAI image provider wiring.
 *
 * The OpenAIImageAdapter existed for a release before anything constructed it:
 * ImageGenerationService skipped it, the generateImage tool's provider enum
 * and fallback lists only knew google/openrouter, and the executePrompts
 * parser rejected provider 'openai' outright. These tests pin every seam an
 * OpenAI image request crosses, so the adapter cannot silently drop off again.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { ImageGenerationService } from '../../src/services/llm/ImageGenerationService';
import { GenerateImageTool } from '../../src/agents/promptManager/tools/generateImage';
import { PromptParser } from '../../src/agents/promptManager/tools/executePrompts/utils/promptParser';
import { DEFAULT_LLM_PROVIDER_SETTINGS, LLMProviderSettings } from '../../src/types/llm/ProviderTypes';
import { jsonResponse, CapturedRequest } from './helpers/llmAdapterTestHarness';

function pngBase64(width: number, height: number): string {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

function settingsWith(providers: Array<'openai' | 'google' | 'openrouter'>): LLMProviderSettings {
  const settings = JSON.parse(JSON.stringify(DEFAULT_LLM_PROVIDER_SETTINGS)) as LLMProviderSettings;
  for (const provider of providers) {
    settings.providers[provider] = { ...settings.providers[provider], apiKey: `${provider}-test`, enabled: true };
  }
  return settings;
}

function makeVault() {
  const saved: Array<{ path: string; bytes: ArrayBuffer }> = [];
  const vault = {
    getAbstractFileByPath: jest.fn(() => null),
    createFolder: jest.fn(async () => undefined),
    createBinary: jest.fn(async (path: string, bytes: ArrayBuffer) => {
      saved.push({ path, bytes });
      return { path };
    })
  };
  return { vault, saved };
}

function openAIImagesResponse(b64: string) {
  return jsonResponse(200, {
    created: 1,
    data: [{ b64_json: b64 }],
    size: '1024x1024',
    quality: 'medium',
    output_format: 'png',
    usage: {
      input_tokens: 16,
      output_tokens: 1756,
      total_tokens: 1772,
      output_tokens_details: { image_tokens: 1756, text_tokens: 0 }
    }
  });
}

describe('OpenAI image provider wiring', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('ImageGenerationService', () => {
    it('initializes the OpenAI adapter from an enabled OpenAI key', () => {
      const { vault } = makeVault();
      const service = new ImageGenerationService(vault as never, settingsWith(['openai']));

      expect(service.getInitializedProviders()).toEqual(['openai']);
      expect(service.getSupportedModelIds('openai')).toContain('gpt-image-2');
      expect(service.getAvailableProviders().find(p => p.provider === 'openai')).toMatchObject({
        available: true
      });
    });

    it('does not initialize OpenAI when the key is present but the provider is disabled', () => {
      const settings = settingsWith(['openai']);
      settings.providers.openai.enabled = false;
      const { vault } = makeVault();
      const service = new ImageGenerationService(vault as never, settings);

      expect(service.getInitializedProviders()).not.toContain('openai');
      expect(service.getAvailableProviders().find(p => p.provider === 'openai')).toMatchObject({
        available: false,
        error: 'API key not configured'
      });
    });

    it('routes provider openai to the Images API once and saves the bytes', async () => {
      const requests: CapturedRequest[] = [];
      const b64 = pngBase64(1024, 1024);
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return openAIImagesResponse(b64);
      });

      const { vault, saved } = makeVault();
      const service = new ImageGenerationService(vault as never, settingsWith(['openai']));

      const result = await service.generateImage({
        prompt: 'a blue teacup',
        provider: 'openai',
        model: 'gpt-image-2',
        savePath: 'images/cup.png'
      });

      expect(result.success).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('https://api.openai.com/v1/images/generations');
      expect(requests[0].headers?.Authorization).toBe('Bearer openai-test');
      expect(JSON.parse(requests[0].body || '{}')).toMatchObject({ model: 'gpt-image-2', prompt: 'a blue teacup' });
      expect(saved).toHaveLength(1);
      expect(Buffer.from(saved[0].bytes).toString('base64')).toBe(b64);
      expect(result.data?.provider).toBe('openai-image');
    });
  });

  describe('GenerateImageTool', () => {
    it('offers openai and its models in the schema and falls back to it when it is the only provider', () => {
      const { vault } = makeVault();
      const tool = new GenerateImageTool({ vault: vault as never, llmSettings: settingsWith(['openai']) });

      const schema = tool.getParameterSchema() as {
        properties: {
          provider: { enum: string[]; default: string };
          model: { enum: string[]; default: string };
        };
      };

      expect(schema.properties.provider.enum).toEqual(['openai']);
      expect(schema.properties.provider.default).toBe('openai');
      expect(schema.properties.model.enum).toContain('gpt-image-2');
      expect(schema.properties.model.default).toBe('gpt-image-2');
    });

    it('lists all three providers when every key is configured', () => {
      const { vault } = makeVault();
      const tool = new GenerateImageTool({
        vault: vault as never,
        llmSettings: settingsWith(['google', 'openai', 'openrouter'])
      });

      const schema = tool.getParameterSchema() as { properties: { provider: { enum: string[] } } };
      expect([...schema.properties.provider.enum].sort()).toEqual(['google', 'openai', 'openrouter']);
    });

    it('executes an openai request end to end through the tool', async () => {
      const b64 = pngBase64(1024, 1024);
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return openAIImagesResponse(b64);
      });

      const { vault, saved } = makeVault();
      const tool = new GenerateImageTool({ vault: vault as never, llmSettings: settingsWith(['openai']) });

      const result = await tool.execute({
        prompt: 'a blue teacup',
        provider: 'openai',
        savePath: 'images/cup.png'
      } as never);

      expect(result.success).toBe(true);
      expect(result.data?.imagePath).toBe('images/cup.png');
      expect(requests).toHaveLength(1);
      expect(saved).toHaveLength(1);
    });
  });

  describe('PromptParser', () => {
    const parser = new PromptParser();

    it('accepts provider openai on image requests', () => {
      const result = parser.validateParameters({
        prompts: [{ type: 'image', prompt: 'x', provider: 'openai', savePath: 'images/x.png' }]
      } as never);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('still rejects an unknown image provider, naming all three', () => {
      const result = parser.validateParameters({
        prompts: [{ type: 'image', prompt: 'x', provider: 'stability', savePath: 'images/x.png' }]
      } as never);

      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toMatch(/provider must be 'google', 'openrouter' or 'openai'/);
    });
  });
});
