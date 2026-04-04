import { requestUrl } from 'obsidian';
import { BaseTranscriptionAdapter } from '../BaseTranscriptionAdapter';
import type {
  AudioChunk,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionSegment,
  TranscriptionWord
} from '../../types/VoiceTypes';

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 80;

export class AssemblyAITranscriptionAdapter extends BaseTranscriptionAdapter {
  readonly provider: TranscriptionProvider = 'assemblyai';
  private readonly uploadEndpoint = 'https://api.assemblyai.com/v2/upload';
  private readonly transcriptEndpoint = 'https://api.assemblyai.com/v2/transcript';

  async transcribeChunk(
    chunk: AudioChunk,
    request: TranscriptionRequest & { provider: TranscriptionProvider; model: string }
  ): Promise<TranscriptionSegment[]> {
    const audioUrl = await this.uploadChunk(chunk);
    const transcriptId = await this.submitTranscript(audioUrl, request);
    const transcript = await this.pollTranscript(transcriptId);
    return this.parseTranscript(transcript, chunk.durationSeconds);
  }

  private async uploadChunk(chunk: AudioChunk): Promise<string> {
    const response = await requestUrl({
      url: this.uploadEndpoint,
      method: 'POST',
      headers: {
        Authorization: this.config.apiKey,
        'Content-Type': 'application/octet-stream'
      },
      body: chunk.data
    });

    if (response.status !== 200) {
      throw new Error(`AssemblyAI upload failed: HTTP ${response.status}`);
    }

    const parsed = response.json as { upload_url?: unknown };
    if (typeof parsed.upload_url !== 'string' || !parsed.upload_url) {
      throw new Error('AssemblyAI upload did not return an upload URL');
    }

    return parsed.upload_url;
  }

  private async submitTranscript(
    audioUrl: string,
    request: TranscriptionRequest & { provider: TranscriptionProvider; model: string }
  ): Promise<string> {
    const response = await requestUrl({
      url: this.transcriptEndpoint,
      method: 'POST',
      headers: {
        Authorization: this.config.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        speech_models: [request.model],
        speaker_labels: request.requestSpeakerLabels === true,
        punctuate: true,
        format_text: true,
        prompt: request.prompt?.trim() || undefined
      })
    });

    if (response.status !== 200) {
      throw new Error(`AssemblyAI transcript submit failed: HTTP ${response.status}`);
    }

    const parsed = response.json as { id?: unknown; error?: unknown };
    if (typeof parsed.id !== 'string' || !parsed.id) {
      throw new Error(
        typeof parsed.error === 'string' ? parsed.error : 'AssemblyAI transcript submit did not return an ID'
      );
    }

    return parsed.id;
  }

  private async pollTranscript(transcriptId: string): Promise<unknown> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const response = await requestUrl({
        url: `${this.transcriptEndpoint}/${transcriptId}`,
        method: 'GET',
        headers: {
          Authorization: this.config.apiKey
        }
      });

      if (response.status !== 200) {
        throw new Error(`AssemblyAI transcript poll failed: HTTP ${response.status}`);
      }

      const parsed = response.json as { status?: unknown; error?: unknown };
      if (parsed.status === 'completed') {
        return response.json;
      }

      if (parsed.status === 'error') {
        throw new Error(typeof parsed.error === 'string' ? parsed.error : 'AssemblyAI transcription failed');
      }

      await this.sleep(POLL_INTERVAL_MS);
    }

    throw new Error('AssemblyAI transcription timed out while polling transcript status');
  }

  private parseTranscript(data: unknown, chunkDurationSeconds: number): TranscriptionSegment[] {
    const parsed = data as {
      text?: unknown;
      confidence?: unknown;
      words?: Array<{
        text?: unknown;
        start?: unknown;
        end?: unknown;
        confidence?: unknown;
        speaker?: unknown;
      }>;
      utterances?: Array<{
        start?: unknown;
        end?: unknown;
        text?: unknown;
        confidence?: unknown;
        speaker?: unknown;
        words?: Array<{
          text?: unknown;
          start?: unknown;
          end?: unknown;
          confidence?: unknown;
          speaker?: unknown;
        }>;
      }>;
    };

    if (Array.isArray(parsed.utterances) && parsed.utterances.length > 0) {
      return parsed.utterances.map(utterance => ({
        startSeconds: typeof utterance.start === 'number' ? utterance.start / 1000 : 0,
        endSeconds: typeof utterance.end === 'number' ? utterance.end / 1000 : chunkDurationSeconds,
        text: typeof utterance.text === 'string' ? utterance.text.trim() : '',
        confidence: typeof utterance.confidence === 'number' ? utterance.confidence : undefined,
        speaker: typeof utterance.speaker === 'string' ? utterance.speaker : undefined,
        words: this.parseWords(utterance.words)
      })).filter(segment => segment.text.length > 0);
    }

    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    if (!text) {
      return [];
    }

    const words = this.parseWords(parsed.words);
    return [{
      startSeconds: 0,
      endSeconds: chunkDurationSeconds,
      text,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
      words: words.length > 0 ? words : undefined
    }];
  }

  private parseWords(
    words: Array<{
      text?: unknown;
      start?: unknown;
      end?: unknown;
      confidence?: unknown;
      speaker?: unknown;
    }> | undefined
  ): TranscriptionWord[] {
    if (!Array.isArray(words)) {
      return [];
    }

    return words.flatMap(word => {
      if (typeof word.text !== 'string' || typeof word.start !== 'number' || typeof word.end !== 'number') {
        return [];
      }

      return [{
        text: word.text,
        startSeconds: word.start / 1000,
        endSeconds: word.end / 1000,
        confidence: typeof word.confidence === 'number' ? word.confidence : undefined,
        speaker: typeof word.speaker === 'string' ? word.speaker : undefined
      }];
    });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}
