/**
 * Location: src/agents/ingestManager/tools/services/TranscriptionService.ts
 * Purpose: Audio transcription via OpenAI Whisper (OpenAI/Groq) endpoints.
 * Handles chunking for large files and merges segment timestamps.
 *
 * Used by: IngestionPipelineService
 * Dependencies: AudioChunkingService, MultipartFormDataBuilder, requestUrl (Obsidian)
 */

import { requestUrl } from 'obsidian';
import { TranscriptionSegment, AudioChunk } from '../../types';
import { chunkAudio } from './AudioChunkingService';
import { buildMultipartFormData } from './MultipartFormDataBuilder';

/** Provider endpoint configuration */
const WHISPER_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/audio/transcriptions',
  groq: 'https://api.groq.com/openai/v1/audio/transcriptions',
};

/** Default Whisper models per provider */
const DEFAULT_WHISPER_MODELS: Record<string, string> = {
  openai: 'whisper-1',
  groq: 'whisper-large-v3-turbo',
};

export interface TranscriptionServiceDeps {
  /** Get API key for a provider */
  getApiKey: (provider: string) => string | undefined;
}

/**
 * Transcribe an audio file using the Whisper API.
 * Automatically chunks files >25MB (desktop only).
 * Returns timestamped segments.
 */
export async function transcribeAudio(
  audioData: ArrayBuffer,
  mimeType: string,
  fileName: string,
  provider: string,
  model: string | undefined,
  deps: TranscriptionServiceDeps
): Promise<TranscriptionSegment[]> {
  const endpoint = WHISPER_ENDPOINTS[provider];
  if (!endpoint) {
    throw new Error(
      `Provider "${provider}" does not support audio transcription. ` +
      `Supported providers: ${Object.keys(WHISPER_ENDPOINTS).join(', ')}`
    );
  }

  const apiKey = deps.getApiKey(provider);
  if (!apiKey) {
    throw new Error(`No API key configured for provider "${provider}"`);
  }

  const whisperModel = model || DEFAULT_WHISPER_MODELS[provider] || 'whisper-1';

  // Chunk audio if needed (>25MB)
  const chunks = await chunkAudio(audioData, mimeType);

  const allSegments: TranscriptionSegment[] = [];

  for (const chunk of chunks) {
    const segments = await transcribeChunk(
      chunk,
      fileName,
      whisperModel,
      endpoint,
      apiKey
    );

    // Offset segment timestamps by chunk start time
    for (const segment of segments) {
      allSegments.push({
        startSeconds: segment.startSeconds + chunk.startSeconds,
        endSeconds: segment.endSeconds + chunk.startSeconds,
        text: segment.text,
      });
    }
  }

  return allSegments;
}

/**
 * Transcribe a single audio chunk via the Whisper API.
 */
async function transcribeChunk(
  chunk: AudioChunk,
  fileName: string,
  model: string,
  endpoint: string,
  apiKey: string
): Promise<TranscriptionSegment[]> {
  // Determine file extension from MIME type
  const ext = mimeToExtension(chunk.mimeType);
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const chunkFileName = `${baseName}${ext}`;

  const { body, contentType } = buildMultipartFormData([
    { name: 'file', value: chunk.data, filename: chunkFileName, contentType: chunk.mimeType },
    { name: 'model', value: model },
    { name: 'response_format', value: 'verbose_json' },
    { name: 'timestamp_granularities[]', value: 'segment' },
  ]);

  const response = await requestUrl({
    url: endpoint,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': contentType,
    },
    body,
  });

  if (response.status !== 200) {
    const errorText = typeof response.text === 'string' ? response.text.slice(0, 200) : '';
    throw new Error(`Whisper API error (${response.status}): ${errorText}`);
  }

  const data = response.json;

  // Parse verbose_json response — segments array with start/end/text
  if (data.segments && Array.isArray(data.segments)) {
    return data.segments.map((seg: { start: number; end: number; text: string }) => ({
      startSeconds: seg.start,
      endSeconds: seg.end,
      text: seg.text.trim(),
    }));
  }

  // Fallback: if no segments, return the full text as a single segment
  if (data.text) {
    return [{
      startSeconds: 0,
      endSeconds: data.duration || 0,
      text: data.text.trim(),
    }];
  }

  return [];
}

function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'audio/wav': '.wav',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/ogg': '.ogg',
    'audio/opus': '.opus',
    'audio/flac': '.flac',
    'audio/webm': '.webm',
    'audio/x-ms-wma': '.wma',
  };
  return map[mimeType] || '.bin';
}

/**
 * Get the list of providers that support audio transcription.
 */
export function getTranscriptionProviders(): string[] {
  return Object.keys(WHISPER_ENDPOINTS);
}
