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
  static latestInstance: MockMediaRecorder | null = null;

  state: 'inactive' | 'recording' = 'inactive';
  finalData = 'voice';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    public readonly _stream: MediaStream,
    public readonly _options: { mimeType: string }
  ) {
    MockMediaRecorder.latestInstance = this;
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    this.emitData(this.finalData);
    this.onstop?.();
  }

  emitData(data: string): void {
    this.ondataavailable?.({
      data: new Blob([data], { type: 'audio/webm' })
    } as BlobEvent);
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
    MockMediaRecorder.latestInstance = null;

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

  it('records, transcribes the recording, and returns the transcript when stopped', async () => {
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

  it('combines periodic and final recorder slices before transcribing', async () => {
    const onTranscriptReady = jest.fn();
    const transcribe = jest.fn().mockImplementation(async request => {
      const audioText = new TextDecoder().decode(new Uint8Array(request.audioData));
      return {
        provider: 'openai',
        model: 'whisper-1',
        text: audioText === 'update me on what is happening with Alex'
          ? 'update me on what is happening with Alex'
          : '',
        segments: []
      };
    });

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
      transcribe
    } as never);

    const controller = new ChatVoiceInputController({} as App, {
      onStateChange: jest.fn(),
      onTranscriptReady,
      onError: jest.fn()
    });

    await controller.startRecording();
    MockMediaRecorder.latestInstance?.emitData('update me on what is happening with ');
    if (MockMediaRecorder.latestInstance) {
      MockMediaRecorder.latestInstance.finalData = 'Alex';
    }
    await controller.stopRecording();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onTranscriptReady).toHaveBeenCalledWith('update me on what is happening with Alex');
  });

  it('prefers resolved chat transcription settings when provided', () => {
    const resolvedSettings = {
      providers: {
        openai: {
          enabled: true,
          apiKey: 'override-key'
        }
      },
      defaultModel: { provider: 'openai', model: 'gpt-4o' },
      defaultTranscriptionModel: { provider: 'openai', model: 'whisper-1' }
    } as never;
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
    }, () => resolvedSettings);

    expect(controller.isAvailable()).toBe(true);
    expect(mockedCreateOrReuse).toHaveBeenCalledWith(resolvedSettings);
    expect(mockedGetNexusPlugin).not.toHaveBeenCalled();
  });
});
