import type { SpeechProvider } from '../llm/types/SpeechTypes';

export interface SpeechSynthesisRequest {
  text: string;
  provider?: string;
  model?: string;
  voice?: string;
}

export interface ResolvedSpeechSynthesisRequest {
  text: string;
  provider: SpeechProvider;
  model: string;
  voice: string;
}

export interface SpeechSynthesisResult {
  provider: SpeechProvider;
  model: string;
  voice: string;
  audioData: ArrayBuffer;
  mimeType: string;
}

export interface SpeechAdapter {
  readonly provider: SpeechProvider;
  isAvailable(): boolean;
  synthesize(request: ResolvedSpeechSynthesisRequest): Promise<SpeechSynthesisResult>;
}
