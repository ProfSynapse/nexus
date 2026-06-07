import { ReadAloudService, type AudioPlaybackFactory, type AudioPlaybackHandle } from '../../src/services/readAloud/ReadAloudService';
import { SpeechSynthesisService } from '../../src/services/readAloud/SpeechSynthesisService';
import {
  DEFAULT_LLM_PROVIDER_SETTINGS,
  type LLMProviderConfig,
  type LLMProviderSettings
} from '../../src/types/llm/ProviderTypes';

function providerConfig(overrides: Partial<LLMProviderConfig> = {}): LLMProviderConfig {
  return {
    apiKey: 'test-key',
    enabled: true,
    ...overrides
  };
}

function makeSettings(overrides: Partial<LLMProviderSettings> = {}): LLMProviderSettings {
  return {
    ...DEFAULT_LLM_PROVIDER_SETTINGS,
    providers: {
      ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
      ...overrides.providers
    },
    ...overrides
  };
}

class FakePlaybackHandle implements AudioPlaybackHandle {
  played: Array<{ audioData: ArrayBuffer; mimeType: string }> = [];
  stopped = false;

  async play(audioData: ArrayBuffer, mimeType: string): Promise<void> {
    this.played.push({ audioData, mimeType });
  }

  stop(): void {
    this.stopped = true;
  }
}

class FakePlaybackFactory implements AudioPlaybackFactory {
  handles: FakePlaybackHandle[] = [];

  create(): AudioPlaybackHandle {
    const handle = new FakePlaybackHandle();
    this.handles.push(handle);
    return handle;
  }
}

describe('ReadAloudService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preprocesses markdown and plays generated audio', async () => {
    const synthesizeSpy = jest.spyOn(SpeechSynthesisService.prototype, 'synthesize')
      .mockResolvedValue({
        provider: 'openai',
        model: 'gpt-4o-mini-tts',
        voice: 'marin',
        audioData: new Uint8Array([1, 2, 3]).buffer,
        mimeType: 'audio/mpeg'
      });

    const playbackFactory = new FakePlaybackFactory();
    const service = new ReadAloudService(makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openai: providerConfig()
      },
      defaultSpeechModel: {
        provider: 'openai',
        model: 'gpt-4o-mini-tts',
        source: 'user'
      }
    }), playbackFactory);

    const result = await service.read({
      sourceName: 'Test note',
      markdown: [
        '---',
        'title: Hidden',
        '---',
        '# Visible heading',
        'Read **this** aloud.'
      ].join('\n')
    });

    expect(result).toEqual({ sourceName: 'Test note', chunkCount: 1 });
    expect(synthesizeSpy).toHaveBeenCalledWith({
      text: 'Visible heading Read this aloud.'
    });
    expect(playbackFactory.handles).toHaveLength(1);
    expect(playbackFactory.handles[0].played).toHaveLength(1);
    expect(playbackFactory.handles[0].stopped).toBe(true);
  });
});
