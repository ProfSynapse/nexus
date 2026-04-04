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

export class GoogleTranscriptionAdapter extends BaseTranscriptionAdapter {
  readonly provider: TranscriptionProvider = 'google';

  async transcribeChunk(
    chunk: AudioChunk,
    request: TranscriptionRequest & { provider: TranscriptionProvider; model: string }
  ): Promise<TranscriptionSegment[]> {
    const response = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.config.apiKey
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: request.prompt?.trim() || DEFAULT_PROMPT },
            {
              inline_data: {
                mime_type: chunk.mimeType,
                data: this.arrayBufferToBase64(chunk.data)
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
    const candidates = (data as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
    })?.candidates;
    const parts = candidates?.[0]?.content?.parts || [];

    return parts
      .map(part => typeof part.text === 'string' ? part.text : '')
      .join('\n')
      .trim();
  }
}

