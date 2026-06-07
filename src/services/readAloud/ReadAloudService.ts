import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import type { AppsSettings } from '../../types/apps/AppTypes';
import { MarkdownSpeechPreprocessor, SpeechTextChunk } from './MarkdownSpeechPreprocessor';
import { SpeechSynthesisService } from './SpeechSynthesisService';

export interface ReadAloudRequest {
  markdown: string;
  sourceName?: string;
}

export interface ReadAloudResult {
  sourceName?: string;
  chunkCount: number;
}

export interface AudioPlaybackHandle {
  play(audioData: ArrayBuffer, mimeType: string): Promise<void>;
  stop(): void;
}

export interface AudioPlaybackFactory {
  create(): AudioPlaybackHandle;
}

export class BrowserAudioPlaybackHandle implements AudioPlaybackHandle {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private rejectPlayback: ((error: Error) => void) | null = null;

  async play(audioData: ArrayBuffer, mimeType: string): Promise<void> {
    this.stop();
    const blob = new Blob([audioData], { type: mimeType });
    this.objectUrl = URL.createObjectURL(blob);
    this.audio = new Audio(this.objectUrl);

    await new Promise<void>((resolve, reject) => {
      const audio = this.audio;
      if (!audio) {
        reject(new Error('Audio playback was not initialized.'));
        return;
      }

      this.rejectPlayback = reject;
      audio.onended = () => {
        this.rejectPlayback = null;
        resolve();
      };
      audio.onerror = () => {
        this.rejectPlayback = null;
        reject(new Error('Audio playback failed.'));
      };
      void audio.play().catch(reject);
    });
  }

  stop(): void {
    const rejectPlayback = this.rejectPlayback;
    this.rejectPlayback = null;

    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio.load();
      this.audio = null;
    }

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    rejectPlayback?.(new Error('Read aloud playback was stopped.'));
  }
}

export class BrowserAudioPlaybackFactory implements AudioPlaybackFactory {
  create(): AudioPlaybackHandle {
    return new BrowserAudioPlaybackHandle();
  }
}

export class ReadAloudService {
  private speechService: SpeechSynthesisService;
  private activePlayback: AudioPlaybackHandle | null = null;
  private runId = 0;

  constructor(
    llmSettings: LLMProviderSettings | null,
    appsSettingsOrPlaybackFactory?: AppsSettings | AudioPlaybackFactory,
    private playbackFactory: AudioPlaybackFactory = new BrowserAudioPlaybackFactory()
  ) {
    const appsSettings = isAudioPlaybackFactory(appsSettingsOrPlaybackFactory)
      ? undefined
      : appsSettingsOrPlaybackFactory;
    if (isAudioPlaybackFactory(appsSettingsOrPlaybackFactory)) {
      this.playbackFactory = appsSettingsOrPlaybackFactory;
    }
    this.speechService = new SpeechSynthesisService(llmSettings, { appsSettings });
  }

  isPlaying(): boolean {
    return this.activePlayback !== null;
  }

  stop(): void {
    this.runId += 1;
    this.activePlayback?.stop();
    this.activePlayback = null;
  }

  async read(request: ReadAloudRequest): Promise<ReadAloudResult> {
    const chunks = MarkdownSpeechPreprocessor.preprocess(request.markdown);
    if (chunks.length === 0) {
      throw new Error('There is no readable text in this note.');
    }

    this.stop();
    const currentRun = this.runId;
    this.activePlayback = this.playbackFactory.create();

    try {
      for (const chunk of chunks) {
        this.assertCurrentRun(currentRun);
        await this.playChunk(chunk, currentRun);
      }

      return {
        sourceName: request.sourceName,
        chunkCount: chunks.length,
      };
    } finally {
      if (this.runId === currentRun) {
        this.activePlayback?.stop();
        this.activePlayback = null;
      }
    }
  }

  private async playChunk(chunk: SpeechTextChunk, runId: number): Promise<void> {
    const playback = this.activePlayback;
    if (!playback) {
      throw new Error('Read aloud playback was stopped.');
    }

    const result = await this.speechService.synthesize({ text: chunk.text });
    this.assertCurrentRun(runId);
    await playback.play(result.audioData, result.mimeType);
  }

  private assertCurrentRun(runId: number): void {
    if (this.runId !== runId) {
      throw new Error('Read aloud playback was stopped.');
    }
  }
}

function isAudioPlaybackFactory(value: AppsSettings | AudioPlaybackFactory | undefined): value is AudioPlaybackFactory {
  return typeof value === 'object' && value !== null && typeof (value as AudioPlaybackFactory).create === 'function';
}
