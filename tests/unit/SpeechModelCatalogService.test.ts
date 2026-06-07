import { requestUrl } from 'obsidian';
import { SpeechModelCatalogService } from '../../src/services/readAloud/SpeechModelCatalogService';
import { DEFAULT_LLM_PROVIDER_SETTINGS } from '../../src/types/llm/ProviderTypes';

jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
}));

const requestUrlMock = requestUrl as jest.MockedFunction<typeof requestUrl>;

describe('SpeechModelCatalogService', () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it('returns static models for native providers', async () => {
    const service = new SpeechModelCatalogService();

    const models = await service.getModels('mistral', DEFAULT_LLM_PROVIDER_SETTINGS);
    const googleModels = await service.getModels('google', DEFAULT_LLM_PROVIDER_SETTINGS);

    expect(models.map(model => model.id)).toContain('voxtral-mini-tts-2603');
    expect(googleModels.map(model => model.id)).toContain('gemini-3.1-flash-tts-preview');
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it('loads OpenRouter speech models dynamically', async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: '',
      json: {
        data: [
          { id: 'mistralai/voxtral-mini-tts-2603', name: 'Voxtral Mini TTS' },
          { id: 'openai/gpt-4o-mini-tts-2025-12-15', name: 'GPT-4o mini TTS' },
        ]
      },
    });
    const service = new SpeechModelCatalogService();
    const settings = {
      ...DEFAULT_LLM_PROVIDER_SETTINGS,
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openrouter: { enabled: true, apiKey: 'openrouter-key' }
      }
    };

    const models = await service.getModels('openrouter', settings);

    expect(requestUrlMock).toHaveBeenCalledWith({
      url: 'https://openrouter.ai/api/v1/models?output_modalities=speech',
      method: 'GET',
      headers: {
        Authorization: 'Bearer openrouter-key',
      },
    });
    expect(models).toEqual([
      expect.objectContaining({
        provider: 'openrouter',
        id: 'mistralai/voxtral-mini-tts-2603',
        name: 'Voxtral Mini TTS',
      }),
      expect.objectContaining({
        provider: 'openrouter',
        id: 'openai/gpt-4o-mini-tts-2025-12-15',
        name: 'GPT-4o mini TTS',
      }),
    ]);
  });
});
