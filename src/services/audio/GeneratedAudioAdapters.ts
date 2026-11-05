/**
 * Provider calls for music and sound effects. Each takes the same request and hides
 * its API: dedicated endpoints on ElevenLabs, Interactions on Google, and SSE on
 * OpenRouter, which refuses audio output without `stream: true`.
 */

import { ProviderHttpClient } from '../llm/adapters/shared/ProviderHttpClient';
import type { GeneratedAudioModelDeclaration } from '../llm/types/GeneratedAudioTypes';

export interface GeneratedAudioRequest {
  model: GeneratedAudioModelDeclaration;
  prompt: string;
  durationSeconds?: number;
  instrumental?: boolean;
  loop?: boolean;
  apiKey: string;
}

export interface GeneratedAudioOutput {
  audioData: ArrayBuffer;
  mimeType: string;
  /** Lyrics and structure, when the model writes them. */
  text?: string;
}

/** A full song can take minutes, and a generation that was billed should finish. */
const GENERATION_TIMEOUT_MS = 600_000;
const MP3 = 'audio/mpeg';

/** What a prompt-driven model is asked for, since it has no parameters. */
export function buildGeneratedAudioPrompt(request: Pick<GeneratedAudioRequest, 'model' | 'prompt' | 'durationSeconds' | 'instrumental'>): string {
  const { model, prompt, durationSeconds, instrumental } = request;
  const additions = [
    ...(durationSeconds !== undefined && model.duration.control === 'prompt' ? [`Make it about ${durationSeconds} seconds long.`] : []),
    ...(instrumental && model.instrumental === 'prompt' ? ['Instrumental only, no vocals.'] : []),
  ];
  return additions.length > 0 ? `${prompt.trim()} ${additions.join(' ')}` : prompt;
}

export function generateAudioWithProvider(request: GeneratedAudioRequest): Promise<GeneratedAudioOutput> {
  switch (request.model.provider) {
    case 'elevenlabs':
      return request.model.type === 'music' ? elevenLabsMusic(request) : elevenLabsSoundEffect(request);
    case 'google':
      return googleMusic(request);
    case 'openrouter':
      return openRouterMusic(request);
  }
}

async function elevenLabsMusic(request: GeneratedAudioRequest): Promise<GeneratedAudioOutput> {
  const response = await ProviderHttpClient.requestOk({
    provider: 'elevenlabs',
    operation: 'music generation',
    timeoutMs: GENERATION_TIMEOUT_MS,
    responseType: 'binary',
    url: 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128',
    method: 'POST',
    headers: { 'xi-api-key': request.apiKey, 'Content-Type': 'application/json', Accept: MP3 },
    body: JSON.stringify({
      prompt: request.prompt,
      model_id: request.model.id,
      ...(request.durationSeconds !== undefined ? { music_length_ms: Math.round(request.durationSeconds * 1000) } : {}),
      ...(request.instrumental !== undefined ? { force_instrumental: request.instrumental } : {}),
    }),
  });
  return { audioData: response.arrayBuffer, mimeType: MP3 };
}

async function elevenLabsSoundEffect(request: GeneratedAudioRequest): Promise<GeneratedAudioOutput> {
  const response = await ProviderHttpClient.requestOk({
    provider: 'elevenlabs',
    operation: 'sound effect generation',
    timeoutMs: GENERATION_TIMEOUT_MS,
    responseType: 'binary',
    url: 'https://api.elevenlabs.io/v1/sound-generation',
    method: 'POST',
    headers: { 'xi-api-key': request.apiKey, 'Content-Type': 'application/json', Accept: MP3 },
    body: JSON.stringify({
      text: request.prompt,
      model_id: request.model.id,
      ...(request.durationSeconds !== undefined ? { duration_seconds: request.durationSeconds } : {}),
      ...(request.loop !== undefined ? { loop: request.loop } : {}),
    }),
  });
  return { audioData: response.arrayBuffer, mimeType: MP3 };
}

interface InteractionContent { type?: string; text?: string; data?: string; mime_type?: string }
interface InteractionResponse { status?: string; steps?: Array<{ content?: InteractionContent[] }> }

async function googleMusic(request: GeneratedAudioRequest): Promise<GeneratedAudioOutput> {
  const response = await ProviderHttpClient.requestOk<InteractionResponse>({
    provider: 'google',
    operation: 'music generation',
    timeoutMs: GENERATION_TIMEOUT_MS,
    url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
    method: 'POST',
    headers: { 'x-goog-api-key': request.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: request.model.id, input: buildGeneratedAudioPrompt(request) }),
  });

  const content = (response.json?.steps ?? []).flatMap(step => step.content ?? []);
  const audio = content.find(part => part.type === 'audio' && part.data);
  if (!audio?.data) {
    throw new Error(`Google returned no audio (status ${response.json?.status ?? 'unknown'}). The prompt may have been blocked: Lyria refuses requests for specific artists or copyrighted lyrics.`);
  }
  return {
    audioData: decodeBase64(audio.data),
    mimeType: audio.mime_type ?? MP3,
    text: cleanLyrics(content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')),
  };
}

interface OpenRouterStreamChunk {
  error?: { message?: string };
  choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; audio?: { data?: string } } }>;
}

async function openRouterMusic(request: GeneratedAudioRequest): Promise<GeneratedAudioOutput> {
  const response = await ProviderHttpClient.requestOk({
    provider: 'openrouter',
    operation: 'music generation',
    timeoutMs: GENERATION_TIMEOUT_MS,
    url: 'https://openrouter.ai/api/v1/chat/completions',
    method: 'POST',
    headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: request.model.id,
      stream: true,
      modalities: ['text', 'audio'],
      messages: [{ role: 'user', content: buildGeneratedAudioPrompt(request) }],
    }),
  });

  // Buffered on purpose: the whole clip is saved at once, so nothing reads it early.
  let audio = '';
  let text = '';
  let finishReason = '';
  for (const line of response.text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let chunk: OpenRouterStreamChunk;
    try {
      chunk = JSON.parse(payload) as OpenRouterStreamChunk;
    } catch {
      continue;
    }
    // A failure after the stream opened still arrives as HTTP 200.
    if (chunk.error) throw new Error(`OpenRouter could not generate this: ${chunk.error.message ?? 'unknown error'}`);
    finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
    const delta = chunk.choices?.[0]?.delta;
    audio += delta?.audio?.data ?? '';
    text += delta?.content ?? '';
  }

  // Seen intermittently on a prompt that worked on retry. Not retried here: it could bill twice.
  if (!audio) {
    throw new Error(`OpenRouter returned no audio${finishReason ? ` (finish reason ${finishReason})` : ''}. This can be temporary, so try again; if it keeps happening, the prompt may be blocked.`);
  }
  return { audioData: decodeBase64(audio), mimeType: MP3, text: cleanLyrics(text) };
}

/**
 * Lyria's text mixes lyrics with structure: `<instrumental>` when there are no words,
 * section markers such as `[[A0]]`, and timing such as `[0.0:]` or an empty `[:]`.
 * Keep real timing, and report nothing when no words remain.
 */
export function cleanLyrics(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map(line => line.replace(/^\[:\]\s*/, '').trim())
    .filter(line => line && line !== '<instrumental>' && !/^\[\[[^\]]*\]\]$/.test(line));
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
