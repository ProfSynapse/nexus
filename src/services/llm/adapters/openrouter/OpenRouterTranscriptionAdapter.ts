import { requestUrl } from 'obsidian';
import { BaseTranscriptionAdapter } from '../BaseTranscriptionAdapter';
import type {
  AudioChunk,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionSegment
} from '../../types/VoiceTypes';

const DEFAULT_PROMPT =
  'Transcribe this audio verbatim. Return only the transcript text with no commentary, labels, or markdown.';

export class OpenRouterTranscriptionAdapter extends BaseTranscriptionAdapter {
  readonly provider: TranscriptionProvider = 'openrouter';
  private readonly endpoint = 'https://openrouter.ai/api/v1/chat/completions';

  async transcribeChunk(
    chunk: AudioChunk,
    request: TranscriptionRequest & { provider: TranscriptionProvider; model: string }
  ): Promise<TranscriptionSegment[]> {
    const response = await requestUrl({
      url: this.endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        ...(this.config.httpReferer ? { 'HTTP-Referer': this.config.httpReferer } : {}),
        ...(this.config.xTitle ? { 'X-Title': this.config.xTitle } : {})
      },
      body: JSON.stringify({
        model: request.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: request.prompt?.trim() || DEFAULT_PROMPT
              },
              {
                type: 'input_audio',
                input_audio: {
                  data: this.arrayBufferToBase64(chunk.data),
                  format: this.mimeToOpenRouterFormat(chunk.mimeType)
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

    const text = this.extractContent(response.json as unknown);
    if (!text) {
      return [];
    }

    return [{
      startSeconds: 0,
      endSeconds: chunk.durationSeconds,
      text
    }];
  }

  private extractContent(data: unknown): string {
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
}

