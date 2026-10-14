/**
 * Retired image and video model ids: the catalogs no longer offer them, every
 * successor is a model the same provider still offers, and the places that
 * turn a stored or caller-supplied id into a request map them.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import {
  getRetiredImageModel,
  getRetiredVideoModel,
  listRetiredImageModels,
  listRetiredVideoModels,
  normalizeRetiredMediaDefaults,
} from '../../src/services/llm/types/RetiredMediaModels';
import { GEMINI_IMAGE_MODEL_SPECS } from '../../src/services/llm/adapters/google/GeminiImageAdapter';
import { OPENAI_IMAGE_MODEL_SPECS } from '../../src/services/llm/adapters/openai/OpenAIImageAdapter';
import { OPENROUTER_IMAGE_MODEL_SPECS } from '../../src/services/llm/adapters/openrouter/OpenRouterImageAdapter';
import { getVideoModel } from '../../src/services/llm/types/VideoTypes';
import { GenerateImageTool } from '../../src/agents/promptManager/tools/generateImage';
import { ModelAgentManager } from '../../src/ui/chat/services/ModelAgentManager';
import type { ConversationMetadataWithCompaction } from '../../src/ui/chat/services/ModelAgentConversationSettingsStore';
import { DEFAULT_LLM_PROVIDER_SETTINGS, type LLMProviderSettings } from '../../src/types/llm/ProviderTypes';
import { jsonResponse, type CapturedRequest } from './helpers/llmAdapterTestHarness';

const IMAGE_CATALOGS: Record<string, Readonly<Record<string, unknown>>> = {
  google: GEMINI_IMAGE_MODEL_SPECS,
  openai: OPENAI_IMAGE_MODEL_SPECS,
  openrouter: OPENROUTER_IMAGE_MODEL_SPECS,
};

function pngBase64(width: number, height: number): string {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

function settingsWith(provider: 'openai' | 'google' | 'openrouter'): LLMProviderSettings {
  const settings = JSON.parse(JSON.stringify(DEFAULT_LLM_PROVIDER_SETTINGS)) as LLMProviderSettings;
  settings.providers[provider] = { ...settings.providers[provider], apiKey: `${provider}-test`, enabled: true };
  return settings;
}

describe('retired media model table', () => {
  it.each(listRetiredImageModels().flatMap(entry => entry.providers.map(provider => [provider, entry.id, entry.replacement])))(
    '%s no longer offers %s, and does offer its successor %s',
    (provider, id, replacement) => {
      const catalog = IMAGE_CATALOGS[provider];
      expect(Object.keys(catalog)).not.toContain(id);
      expect(Object.keys(catalog)).toContain(replacement);
    }
  );

  it.each(listRetiredVideoModels().map(entry => [entry.provider, entry.id, entry.replacement]))(
    '%s video no longer offers %s, and does offer its successor %s',
    (provider, id, replacement) => {
      expect(getVideoModel(provider, id)).toBeUndefined();
      expect(getVideoModel(provider, replacement)).toBeDefined();
    }
  );

  it('only maps an id on a provider that served it', () => {
    expect(getRetiredImageModel('openai', 'gpt-image-1')?.replacement).toBe('gpt-image-2.5-sunburst');
    expect(getRetiredImageModel('google', 'gpt-image-1')).toBeUndefined();
    expect(getRetiredImageModel('openai', 'gpt-image-2')).toBeUndefined();
    expect(getRetiredVideoModel('openrouter', 'veo-3.1-generate-preview')).toBeUndefined();
    expect(getRetiredVideoModel('openrouter', 'google/veo-3.1-fast')).toBeUndefined();
  });

  it('does not treat inherited object keys as retired ids', () => {
    expect(getRetiredImageModel('openai', 'constructor')).toBeUndefined();
    expect(getRetiredVideoModel('google', 'toString')).toBeUndefined();
  });

  it('reports whether it changed anything', () => {
    const current: LLMProviderSettings = { ...DEFAULT_LLM_PROVIDER_SETTINGS };
    expect(normalizeRetiredMediaDefaults(current)).toBe(false);
    const stale: LLMProviderSettings = {
      ...DEFAULT_LLM_PROVIDER_SETTINGS,
      defaultImageModel: { provider: 'openai', model: 'gpt-image-1-mini' },
    };
    expect(normalizeRetiredMediaDefaults(stale)).toBe(true);
    expect(stale.defaultImageModel).toEqual({ provider: 'openai', model: 'gpt-image-2.5-flare' });
  });
});

describe('generateImage with a retired model id', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs the successor, sends its id to the provider, and says so in the result', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async (request) => {
      requests.push(request);
      return jsonResponse(200, {
        created: 1,
        data: [{ b64_json: pngBase64(1024, 1024) }],
        size: '1024x1024',
        quality: 'medium',
        output_format: 'png',
        usage: { input_tokens: 16, output_tokens: 439, total_tokens: 455, output_tokens_details: { image_tokens: 439, text_tokens: 0 } },
      });
    });
    const vault = {
      getAbstractFileByPath: jest.fn(() => null),
      createFolder: jest.fn(async () => undefined),
      createBinary: jest.fn(async (path: string) => ({ path })),
    };
    const tool = new GenerateImageTool({ vault: vault as never, llmSettings: settingsWith('openai') });

    const result = await tool.execute({
      prompt: 'a blue teacup',
      provider: 'openai',
      model: 'gpt-image-1',
      savePath: 'images/cup.png',
    } as never);

    expect(result.success).toBe(true);
    expect(JSON.parse(String(requests[0].body)).model).toBe('gpt-image-2.5-sunburst');
    expect(result.data?.note).toContain('"gpt-image-1" was retired');
    expect(result.data?.note).toContain('"gpt-image-2.5-sunburst"');
  });

  it('adds no note for a current model', async () => {
    __setRequestUrlMock(async () => jsonResponse(200, {
      created: 1,
      data: [{ b64_json: pngBase64(1024, 1024) }],
      usage: { input_tokens: 16, output_tokens: 439, total_tokens: 455 },
    }));
    const vault = {
      getAbstractFileByPath: jest.fn(() => null),
      createFolder: jest.fn(async () => undefined),
      createBinary: jest.fn(async (path: string) => ({ path })),
    };
    const tool = new GenerateImageTool({ vault: vault as never, llmSettings: settingsWith('openai') });

    const result = await tool.execute({ prompt: 'a cup', provider: 'openai', model: 'gpt-image-2', savePath: 'images/cup.png' } as never);

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('note');
  });
});

describe('a conversation saved with a retired image model', () => {
  it('restores the successor without rewriting the stored metadata', async () => {
    const metadata: ConversationMetadataWithCompaction = {
      chatSettings: { imageProvider: 'google', imageModel: 'gemini-3.1-flash-image-preview' },
    } as ConversationMetadataWithCompaction;
    const persistence = {
      getConversation: jest.fn(async () => ({ metadata })),
      updateConversationMetadata: jest.fn(async () => undefined),
    };
    const manager = new ModelAgentManager(
      {},
      { onModelChanged: jest.fn(), onPromptChanged: jest.fn(), onSystemPromptChanged: jest.fn() },
      persistence,
      'conversation'
    );

    await manager.initializeFromConversation('conversation');

    expect(manager.getImageProvider()).toBe('google');
    expect(manager.getImageModel()).toBe('gemini-nano-banana-2.1');
    expect(persistence.updateConversationMetadata).not.toHaveBeenCalled();
  });
});
