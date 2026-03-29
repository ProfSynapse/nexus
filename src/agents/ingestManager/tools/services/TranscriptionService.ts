/**
 * Location: src/agents/ingestManager/tools/services/TranscriptionService.ts
 * Purpose: Audio transcription across explicit ingestion-approved models.
 * Supports:
 * - OpenAI/Groq speech-to-text endpoints
 * - Google Gemini audio understanding
 * - OpenRouter multimodal audio input
 *
 * Used by: IngestionPipelineService
 */

import { requestUrl } from 'obsidian';
import { TranscriptionSegment, AudioChunk } from '../../types';
import { chunkAudio } from './AudioChunkingService';
import { buildMultipartFormData } from './MultipartFormDataBuilder';
import {
  getIngestionModel,
  getIngestionModelsForProvider
} from './IngestModelCatalog';

const SPEECH_API_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/audio/transcriptions',
  groq: 'https://api.groq.com/openai/v1/audio/transcriptions',
};

const DEFAULT_TRANSCRIPTION_PROMPT =
  'Transcribe this audio verbatim. Return only the transcript text with no commentary, labels, or markdown.';

export interface TranscriptionServiceDeps {
  /** Get API key for a provider */
  getApiKey: (provider: string) => string | undefined;
  /** OpenRouter attribution headers */
  getOpenRouterHeaders?: () => { httpReferer?: string; xTitle?: string };
}

/**
 * Transcribe an audio file using the configured model.
 */
export async function transcribeAudio(
  audioData: ArrayBuffer,
  mimeType: string,
  fileName: string,
  provider: string,
  model: string | undefined,
  deps: TranscriptionServiceDeps
): Promise<TranscriptionSegment[]> {
  const apiKey = deps.getApiKey(provider);
  if (!apiKey) {
    throw new Error(`No API key configured for provider "${provider}"`);
  }

  const transcriptionModel = model || getDefaultTranscriptionModel(provider);
  const declaration = transcriptionModel
    ? getIngestionModel(provider, transcriptionModel, 'transcription')
    : undefined;

  if (!transcriptionModel || !declaration?.execution) {
    throw new Error(
      `Provider "${provider}" does not support the transcription model "${transcriptionModel ?? 'unknown'}".`
    );
  }
  const resolvedModel = transcriptionModel;

  const chunks = await chunkAudio(audioData, mimeType);
  const allSegments: TranscriptionSegment[] = [];

  for (const chunk of chunks) {
    const segments = declaration.execution === 'multimodal-audio'
          ? await transcribeChunkWithMultimodalModel(
          chunk,
          provider,
          resolvedModel,
          apiKey,
          deps
        )
      : await transcribeChunkWithSpeechApi(
          chunk,
          fileName,
          resolvedModel,
          declaration.execution,
          provider,
          apiKey
        );

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

function getDefaultTranscriptionModel(provider: string): string | undefined {
  return getIngestionModelsForProvider(provider, 'transcription')[0]?.id;
}

async function transcribeChunkWithSpeechApi(
  chunk: AudioChunk,
  fileName: string,
  model: string,
  execution: 'speech-api-segmented' | 'speech-api-plain',
  provider: string,
  apiKey: string
): Promise<TranscriptionSegment[]> {
  const endpoint = SPEECH_API_ENDPOINTS[provider];
  if (!endpoint) {
    throw new Error(`Provider "${provider}" does not support speech API transcription`);
  }

  const ext = mimeToExtension(chunk.mimeType);
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const chunkFileName = `${baseName}${ext}`;
  const fields = [
    { name: 'file', value: chunk.data, filename: chunkFileName, contentType: chunk.mimeType },
    { name: 'model', value: model },
  ];

  if (execution === 'speech-api-segmented') {
    fields.push(
      { name: 'response_format', value: 'verbose_json' },
      { name: 'timestamp_granularities[]', value: 'segment' }
    );
  } else {
    fields.push({ name: 'response_format', value: 'json' });
  }

  const { body, contentType } = buildMultipartFormData(fields);

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
    console.error(
      '[TranscriptionService] Speech API error:',
      response.status,
      typeof response.text === 'string' ? response.text.slice(0, 200) : ''
    );
    throw new Error(`Transcription failed: HTTP ${response.status}`);
  }

  const data = response.json;
  if (execution === 'speech-api-segmented') {
    return parseSegmentedSpeechApiResponse(data, chunk.durationSeconds);
  }

  const text = extractSpeechApiText(data);
  return text ? [{
    startSeconds: 0,
    endSeconds: chunk.durationSeconds,
    text,
  }] : [];
}

async function transcribeChunkWithMultimodalModel(
  chunk: AudioChunk,
  provider: string,
  model: string,
  apiKey: string,
  deps: TranscriptionServiceDeps
): Promise<TranscriptionSegment[]> {
  let text: string;

  if (provider === 'google') {
    text = await transcribeWithGoogle(chunk, model, apiKey);
  } else if (provider === 'openrouter') {
    text = await transcribeWithOpenRouter(chunk, model, apiKey, deps);
  } else {
    throw new Error(`Provider "${provider}" does not support multimodal audio transcription`);
  }

  return text ? [{
    startSeconds: 0,
    endSeconds: chunk.durationSeconds,
    text,
  }] : [];
}

async function transcribeWithGoogle(
  chunk: AudioChunk,
  model: string,
  apiKey: string
): Promise<string> {
  const response = await requestUrl({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: DEFAULT_TRANSCRIPTION_PROMPT },
          {
            inline_data: {
              mime_type: chunk.mimeType,
              data: arrayBufferToBase64(chunk.data)
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 65536
      }
    })
  });

  if (response.status !== 200) {
    throw new Error(`Google transcription failed: HTTP ${response.status}`);
  }

  return extractGoogleContent(response.json);
}

async function transcribeWithOpenRouter(
  chunk: AudioChunk,
  model: string,
  apiKey: string,
  deps: TranscriptionServiceDeps
): Promise<string> {
  const { httpReferer, xTitle } = deps.getOpenRouterHeaders?.() || {};

  const response = await requestUrl({
    url: 'https://openrouter.ai/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(httpReferer ? { 'HTTP-Referer': httpReferer } : {}),
      ...(xTitle ? { 'X-Title': xTitle } : {})
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: DEFAULT_TRANSCRIPTION_PROMPT
            },
            {
              type: 'input_audio',
              input_audio: {
                data: arrayBufferToBase64(chunk.data),
                format: mimeToOpenRouterFormat(chunk.mimeType)
              }
            }
          ]
        }
      ],
      stream: false,
      temperature: 0
    })
  });

  if (response.status !== 200) {
    throw new Error(`OpenRouter transcription failed: HTTP ${response.status}`);
  }

  return extractOpenRouterContent(response.json);
}

function parseSegmentedSpeechApiResponse(
  data: unknown,
  chunkDurationSeconds: number
): TranscriptionSegment[] {
  const parsed = data as {
    text?: string;
    duration?: number;
    segments?: Array<{ start: number; end: number; text: string }>;
  };

  if (Array.isArray(parsed.segments)) {
    return parsed.segments.map(seg => ({
      startSeconds: seg.start,
      endSeconds: seg.end,
      text: seg.text.trim(),
    }));
  }

  const text = extractSpeechApiText(data);
  return text ? [{
    startSeconds: 0,
    endSeconds: parsed.duration || chunkDurationSeconds,
    text,
  }] : [];
}

function extractSpeechApiText(data: unknown): string {
  const parsed = data as { text?: unknown };
  return typeof parsed.text === 'string' ? parsed.text.trim() : '';
}

function extractGoogleContent(data: unknown): string {
  const candidates = (data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
  })?.candidates;
  const parts = candidates?.[0]?.content?.parts || [];

  return parts
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .join('\n')
    .trim();
}

function extractOpenRouterContent(data: unknown): string {
  const choices = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map(part => {
      if (typeof part === 'string') {
        return part;
      }

      if (part && typeof part === 'object' && 'text' in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }

      return '';
    })
    .join('\n')
    .trim();
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

function mimeToOpenRouterFormat(mimeType: string): string {
  const ext = mimeToExtension(mimeType);
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
