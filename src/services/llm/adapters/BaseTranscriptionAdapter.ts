import type {
  AudioChunk,
  TranscriptionModelDeclaration,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionSegment
} from '../types/VoiceTypes';
import { getTranscriptionModelsForProvider } from '../types/VoiceTypes';

export interface TranscriptionAdapterConfig {
  apiKey: string;
  httpReferer?: string;
  xTitle?: string;
}

export abstract class BaseTranscriptionAdapter {
  abstract readonly provider: TranscriptionProvider;

  constructor(protected config: TranscriptionAdapterConfig) {}

  isAvailable(): boolean {
    return Boolean(this.config.apiKey);
  }

  getModels(): TranscriptionModelDeclaration[] {
    return getTranscriptionModelsForProvider(this.provider);
  }

  abstract transcribeChunk(
    chunk: AudioChunk,
    request: TranscriptionRequest & { provider: TranscriptionProvider; model: string },
    options?: { signal?: AbortSignal }
  ): Promise<TranscriptionSegment[]>;

  protected mimeToExtension(mimeType: string): string {
    const map: Record<string, string> = {
      'audio/wav': '.wav',
      'audio/mpeg': '.mp3',
      'audio/mp4': '.m4a',
      'audio/aac': '.aac',
      'audio/ogg': '.ogg',
      'audio/opus': '.opus',
      'audio/flac': '.flac',
      'audio/webm': '.webm',
      'audio/x-ms-wma': '.wma'
    };

    return map[mimeType] || '.bin';
  }

  protected buildChunkFileName(fileName: string, mimeType: string): string {
    const baseName = fileName.replace(/\.[^.]+$/, '');
    return `${baseName}${this.mimeToExtension(mimeType)}`;
  }
}

