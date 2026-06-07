import { requestUrl } from 'obsidian';
import {
  getSpeechModel,
  type SpeechProvider,
} from '../llm/types/SpeechTypes';
import type {
  ResolvedSpeechSynthesisRequest,
  SpeechAdapter,
  SpeechSynthesisResult
} from './SpeechSynthesisTypes';

export interface ElevenLabsSpeechAdapterConfig {
  apiKey: string;
}

export class ElevenLabsSpeechAdapter implements SpeechAdapter {
  readonly provider: SpeechProvider = 'elevenlabs';

  constructor(private config: ElevenLabsSpeechAdapterConfig) {}

  isAvailable(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  async synthesize(request: ResolvedSpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    if (request.provider !== this.provider) {
      throw new Error(`ElevenLabs speech adapter cannot synthesize provider "${request.provider}".`);
    }

    const declaration = getSpeechModel(request.provider, request.model);
    if (!declaration) {
      throw new Error(`Unsupported ElevenLabs speech model "${request.model}".`);
    }

    const response = await requestUrl({
      url: `https://api.elevenlabs.io/v1/text-to-speech/${request.voice}`,
      method: 'POST',
      headers: {
        'xi-api-key': this.config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: request.text,
        model_id: request.model,
      }),
    });

    if (response.status !== 200) {
      const errorText = typeof response.text === 'string' ? response.text : 'Unknown error';
      throw new Error(`ElevenLabs speech failed: HTTP ${response.status}: ${errorText}`);
    }

    return {
      provider: this.provider,
      model: request.model,
      voice: request.voice,
      audioData: response.arrayBuffer,
      mimeType: 'audio/mpeg',
    };
  }
}
