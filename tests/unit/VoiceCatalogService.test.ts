import { requestUrl } from 'obsidian';
import { VoiceCatalogService } from '../../src/services/readAloud/VoiceCatalogService';

jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
}));

const requestUrlMock = requestUrl as jest.MockedFunction<typeof requestUrl>;

describe('VoiceCatalogService', () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it('returns static OpenAI voices from the model catalog', async () => {
    const service = new VoiceCatalogService();

    const voices = await service.getVoices('openai', 'gpt-4o-mini-tts');

    expect(voices.map(voice => voice.id)).toEqual(
      expect.arrayContaining(['marin', 'cedar', 'nova', 'onyx'])
    );
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it('returns static Google Gemini TTS voices from the model catalog', async () => {
    const service = new VoiceCatalogService();

    const voices = await service.getVoices('google', 'gemini-3.1-flash-tts-preview');

    expect(voices).toEqual(expect.arrayContaining([
      { id: 'Kore', name: 'Kore', description: 'Firm' },
      { id: 'Puck', name: 'Puck', description: 'Upbeat' },
      { id: 'Sulafat', name: 'Sulafat', description: 'Warm' },
    ]));
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it('loads ElevenLabs voices from configured app credentials', async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: '',
      json: {
        voices: [
          { voice_id: 'voice-1', name: 'Rachel', category: 'premade' },
          { voice_id: 'voice-2', name: 'Custom Voice', category: 'cloned' },
        ]
      },
    });

    const service = new VoiceCatalogService();
    const voices = await service.getVoices('elevenlabs', 'eleven_multilingual_v2', {
      appsSettings: {
        apps: {
          elevenlabs: {
            enabled: true,
            credentials: { apiKey: 'test-key' },
            installedAt: '2026-06-07T00:00:00.000Z',
            installedVersion: '1.0.0',
          }
        }
      }
    });

    expect(requestUrlMock).toHaveBeenCalledWith({
      url: 'https://api.elevenlabs.io/v1/voices',
      method: 'GET',
      headers: {
        'xi-api-key': 'test-key',
      },
    });
    expect(voices).toEqual([
      { id: 'voice-1', name: 'Rachel', description: 'premade' },
      { id: 'voice-2', name: 'Custom Voice', description: 'cloned' },
    ]);
  });

  it('does not call ElevenLabs when the app is not enabled', async () => {
    const service = new VoiceCatalogService();

    const voices = await service.getVoices('elevenlabs', 'eleven_multilingual_v2', {
      appsSettings: {
        apps: {
          elevenlabs: {
            enabled: false,
            credentials: { apiKey: 'test-key' },
            installedAt: '2026-06-07T00:00:00.000Z',
            installedVersion: '1.0.0',
          }
        }
      }
    });

    expect(voices).toEqual([]);
    expect(requestUrlMock).not.toHaveBeenCalled();
  });

  it('loads Mistral saved voices from configured provider credentials', async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: '',
      json: {
        items: [
          { id: 'mistral-voice-1', name: 'Narrator' },
          { id: 'mistral-voice-2', name: 'Guide' },
        ]
      },
    });

    const service = new VoiceCatalogService();
    const voices = await service.getVoices('mistral', 'voxtral-mini-tts-2603', {
      llmSettings: {
        providers: {
          mistral: { enabled: true, apiKey: 'mistral-key' }
        },
        defaultModel: { provider: 'openai', model: 'gpt-4o' },
      }
    });

    expect(requestUrlMock).toHaveBeenCalledWith({
      url: 'https://api.mistral.ai/v1/audio/voices',
      method: 'GET',
      headers: {
        Authorization: 'Bearer mistral-key',
      },
    });
    expect(voices).toEqual([
      { id: 'mistral-voice-1', name: 'Narrator' },
      { id: 'mistral-voice-2', name: 'Guide' },
    ]);
  });
});
