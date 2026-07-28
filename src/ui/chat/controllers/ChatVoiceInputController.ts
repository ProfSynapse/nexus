import type { App } from 'obsidian';
import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';
import { TranscriptionService } from '../../../services/llm/TranscriptionService';
import { getNexusPlugin } from '../../../utils/pluginLocator';

type PluginWithLLMSettings = {
  settings?: {
    settings?: {
      llmProviders?: LLMProviderSettings;
    };
  };
};

export type ChatVoiceInputState = 'idle' | 'recording' | 'transcribing';

interface ChatVoiceInputControllerCallbacks {
  onStateChange: (state: ChatVoiceInputState) => void;
  onTranscriptReady: (text: string) => void;
  onError: (message: string) => void;
}

const RECORDER_TIMESLICE_MS = 2500;
const PREFERRED_RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4'
] as const;

export class ChatVoiceInputController {
  private state: ChatVoiceInputState = 'idle';
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private activeMimeType: string | null = null;
  private activeSettings: LLMProviderSettings | null = null;
  private recordedBlobs: Blob[] = [];
  private finalizingRecording = false;
  private recorderStopped = false;
  private finalizePromise: Promise<string> | null = null;
  private resolveFinalize: ((value: string) => void) | null = null;
  private rejectFinalize: ((error: Error) => void) | null = null;
  private recordingError: Error | null = null;

  constructor(
    private readonly app: App | undefined,
    private readonly callbacks: ChatVoiceInputControllerCallbacks,
    private readonly getResolvedLLMSettings?: () => LLMProviderSettings | null
  ) {}

  getState(): ChatVoiceInputState {
    return this.state;
  }

  isAvailable(): boolean {
    return this.getAvailability().available;
  }

  getAvailability(): { available: boolean; reason?: string } {
    const settings = this.getLLMSettings();
    if (!settings) {
      return { available: false, reason: 'No LLM settings available' };
    }

    const transcriptionService = TranscriptionService.createOrReuse(settings);
    const availableProviders = transcriptionService.getAvailableProviders();
    if (!availableProviders.some(provider => provider.available && provider.models.length > 0)) {
      return { available: false, reason: 'No transcription provider configured' };
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return { available: false, reason: 'Microphone capture is not supported here' };
    }

    const mimeType = this.getPreferredRecorderMimeType();
    if (typeof MediaRecorder === 'undefined' || !mimeType) {
      return { available: false, reason: 'Audio recording is not supported here' };
    }

    return { available: true };
  }

  async startRecording(): Promise<boolean> {
    if (this.state !== 'idle') {
      return false;
    }

    const settings = this.getLLMSettings();
    if (!settings) {
      this.callbacks.onError('Voice input is unavailable because transcription is not configured.');
      return false;
    }

    const availability = this.getAvailability();
    if (!availability.available) {
      this.callbacks.onError(availability.reason ?? 'Voice input is unavailable.');
      return false;
    }

    const mimeType = this.getPreferredRecorderMimeType();
    if (!mimeType || typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.callbacks.onError('Audio recording is not supported on this device.');
      return false;
    }

    this.resetSessionState();
    this.activeSettings = settings;
    this.activeMimeType = mimeType;
    this.finalizePromise = new Promise<string>((resolve, reject) => {
      this.resolveFinalize = resolve;
      this.rejectFinalize = reject;
    });

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.recorder = new MediaRecorder(this.stream, { mimeType });
      this.recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          // Timeslice blobs are not guaranteed to be independently playable.
          // Preserve their order and transcribe the complete recording on stop.
          this.recordedBlobs.push(event.data);
        }
      };
      this.recorder.onstop = () => {
        this.recorderStopped = true;
        this.stopStreamTracks();
        this.tryFinalize();
      };
      this.recorder.onerror = () => {
        this.recordingError = this.recordingError ?? new Error('Audio recording failed.');
        this.recorderStopped = true;
        this.stopStreamTracks();
        this.tryFinalize();
      };
      this.recorder.start(RECORDER_TIMESLICE_MS);
      this.setState('recording');
      return true;
    } catch (error) {
      this.cleanup();
      this.callbacks.onError(this.getStartErrorMessage(error));
      return false;
    }
  }

  async stopRecording(): Promise<void> {
    if (this.state !== 'recording') {
      return;
    }

    this.setState('transcribing');

    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    } else {
      this.recorderStopped = true;
      this.stopStreamTracks();
      this.tryFinalize();
    }

    try {
      const transcript = await (this.finalizePromise ?? Promise.resolve(''));
      const normalizedTranscript = transcript.trim();
      if (normalizedTranscript.length > 0) {
        this.callbacks.onTranscriptReady(normalizedTranscript);
      }
      if (this.recordingError && normalizedTranscript.length > 0) {
        this.callbacks.onError('Voice input kept a partial transcript after recording ended unexpectedly.');
      }
    } catch (error) {
      this.callbacks.onError(
        error instanceof Error ? error.message : 'Voice input failed while transcribing.'
      );
    } finally {
      this.cleanup();
    }
  }

  cleanup(): void {
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
      if (this.recorder.state !== 'inactive') {
        try {
          this.recorder.stop();
        } catch {
          // Ignore recorder shutdown failures during cleanup
        }
      }
    }

    this.stopStreamTracks();
    this.recorder = null;
    this.activeMimeType = null;
    this.activeSettings = null;
    this.resetSessionState();
    this.setState('idle');
  }

  private tryFinalize(): void {
    if (!this.recorderStopped || this.finalizingRecording) {
      return;
    }

    this.finalizingRecording = true;
    const combinedBlob = new Blob(this.recordedBlobs, {
      type: this.activeMimeType ?? 'audio/webm'
    });

    void this.transcribeCombinedRecording(combinedBlob);
  }

  private async transcribeCombinedRecording(blob: Blob): Promise<void> {
    try {
      const transcript = blob.size > 0 ? await this.transcribeBlob(blob) : '';
      if (transcript.length > 0) {
        this.resolveFinalize?.(transcript);
      } else if (this.recordingError) {
        this.rejectFinalize?.(this.recordingError);
      } else {
        this.resolveFinalize?.('');
      }
    } catch (error) {
      this.rejectFinalize?.(
        error instanceof Error ? error : new Error('Voice input transcription failed.')
      );
    } finally {
      this.finalizingRecording = false;
      this.resolveFinalize = null;
      this.rejectFinalize = null;
      this.finalizePromise = null;
    }
  }

  private async transcribeBlob(blob: Blob): Promise<string> {
    if (!this.activeSettings) {
      throw new Error('Voice input transcription settings are unavailable.');
    }

    const transcriptionService = TranscriptionService.createOrReuse(this.activeSettings);
    const audioData = await blob.arrayBuffer();
    const mimeType = this.normalizeRecordedMimeType(blob.type || this.activeMimeType || 'audio/webm');
    const extension = mimeType === 'audio/mp4' ? 'm4a' : mimeType === 'audio/wav' ? 'wav' : 'webm';
    const result = await transcriptionService.transcribe({
      audioData,
      mimeType,
      fileName: `chat-voice-input-${Date.now()}.${extension}`
    });

    return result.text.replace(/\s+/g, ' ').trim();
  }

  private stopStreamTracks(): void {
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
  }

  private resetSessionState(): void {
    this.recordedBlobs = [];
    this.finalizingRecording = false;
    this.recorderStopped = false;
    this.recordingError = null;
  }

  private setState(state: ChatVoiceInputState): void {
    if (this.state === state) {
      return;
    }

    this.state = state;
    this.callbacks.onStateChange(state);
  }

  private getPreferredRecorderMimeType(): string | null {
    if (typeof MediaRecorder === 'undefined') {
      return null;
    }

    const supportsType = typeof MediaRecorder.isTypeSupported === 'function'
      ? MediaRecorder.isTypeSupported.bind(MediaRecorder)
      : () => true;

    return PREFERRED_RECORDING_MIME_TYPES.find(type => supportsType(type)) ?? null;
  }

  private getLLMSettings(): LLMProviderSettings | null {
    const resolved = this.getResolvedLLMSettings?.();
    if (resolved) {
      return resolved;
    }

    if (!this.app) {
      return null;
    }

    const plugin = getNexusPlugin(this.app) as PluginWithLLMSettings | null;
    return plugin?.settings?.settings?.llmProviders ?? null;
  }

  private normalizeRecordedMimeType(mimeType: string): string {
    const normalized = mimeType.split(';')[0]?.trim();
    if (normalized === 'audio/mp4' || normalized === 'audio/wav' || normalized === 'audio/webm') {
      return normalized;
    }

    return 'audio/webm';
  }

  private getStartErrorMessage(error: unknown): string {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      return 'Microphone access was denied.';
    }

    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return 'No microphone was found.';
    }

    return error instanceof Error ? error.message : 'Voice input could not start.';
  }
}
