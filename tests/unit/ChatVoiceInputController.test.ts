import type { App } from 'obsidian';
import { ChatVoiceInputController } from '../../src/ui/chat/controllers/ChatVoiceInputController';
import { TranscriptionService } from '../../src/services/llm/TranscriptionService';
import { getNexusPlugin } from '../../src/utils/pluginLocator';

jest.mock('../../src/utils/pluginLocator', () => ({
  getNexusPlugin: jest.fn()
}));

jest.mock('../../src/services/llm/TranscriptionService', () => ({
  TranscriptionService: {
    createOrReuse: jest.fn()
  }
}));

class MockMediaRecorder {
  static isTypeSupported = jest.fn(() => true);

  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    public readonly _stream: MediaStream,
    public readonly _options: { mimeType: string }
  ) {}

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob(['voice'], { type: 'audio/webm' })
    } as BlobEvent);
    this.onstop?.();
  }
}

describe('ChatVoiceInputController', () => {
  const mockedGetNexusPlugin = jest.mocked(getNexusPlugin);
  const mockedCreateOrReuse = jest.mocked(TranscriptionService.createOrReuse);
  const mediaTrackStop = jest.fn();

  beforeEach(() => {
    mockedGetNexusPlugin.mockReset();
    mockedCreateOrReuse.mockReset();
    mediaTrackStop.mockReset();

    Object.defineProperty(global, 'MediaRecorder', {
      writable: true,
      value: MockMediaRecorder
    });

    Object.defineProperty(global.navigator, 'mediaDevices', {
      writable: true,
      value: {
        getUserMedia: jest.fn().mockResolvedValue({
          getTracks: () => [{ stop: mediaTrackStop }]
        })
      }
    });
  });

  it('reports availability when transcription and recording support are configured', () => {
    mockedGetNexusPlugin.mockReturnValue({
      settings: {
        settings: {
          llmProviders: { providers: {} } as never
        }
      }
    } as App);
    mockedCreateOrReuse.mockReturnValue({
      getAvailableProviders: () => [
        {
          provider: 'openai',
          available: true,
          models: [{ id: 'whisper-1' }]
        }
      ]
    } as never);

    const controller = new ChatVoiceInputController({} as App, {
      onStateChange: jest.fn(),
      onTranscriptReady: jest.fn(),
      onError: jest.fn()
    });

    expect(controller.isAvailable()).toBe(true);
  });

  it('records, transcribes queued chunks, and returns the transcript when stopped', async () => {
    const onStateChange = jest.fn();
    const onTranscriptReady = jest.fn();
    const onError = jest.fn();

    mockedGetNexusPlugin.mockReturnValue({
      settings: {
        settings: {
          llmProviders: { providers: {} } as never
        }
      }
    } as App);
    mockedCreateOrReuse.mockReturnValue({
      getAvailableProviders: () => [
        {
          provider: 'openai',
          available: true,
          models: [{ id: 'whisper-1' }]
        }
      ],
      transcribe: jest.fn().mockResolvedValue({
        provider: 'openai',
        model: 'whisper-1',
        text: 'hello world',
        segments: []
      })
    } as never);

    const controller = new ChatVoiceInputController({} as App, {
      onStateChange,
      onTranscriptReady,
      onError
    });

    await controller.startRecording();
    await controller.stopRecording();

    expect(onStateChange).toHaveBeenCalledWith('recording');
    expect(onStateChange).toHaveBeenCalledWith('transcribing');
    expect(onTranscriptReady).toHaveBeenCalledWith('hello world');
    expect(onStateChange).toHaveBeenLastCalledWith('idle');
    expect(onError).not.toHaveBeenCalled();
    expect(mediaTrackStop).toHaveBeenCalled();
  });
});
