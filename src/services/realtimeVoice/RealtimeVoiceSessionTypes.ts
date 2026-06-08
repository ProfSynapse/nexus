import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import type { LiveVoiceComposerState } from '../../ui/chat/types/LiveVoiceTypes';

export interface RealtimeVoiceSessionCallbacks {
  onStateChange: (state: Exclude<LiveVoiceComposerState, 'inactive' | 'error'>) => void;
  onError: (message: string, error?: unknown) => void;
  onUserTranscript?: (text: string) => void;
  onAssistantTranscriptDelta?: (text: string) => void;
}

export interface RealtimeVoiceSession {
  start(): Promise<void>;
  stop(): void;
}

export interface RealtimeVoiceSessionRequest {
  llmSettings: LLMProviderSettings | null;
  instructions?: string;
  callbacks: RealtimeVoiceSessionCallbacks;
}

export interface ResolvedRealtimeVoiceSessionRequest {
  provider: 'openai';
  model: string;
  voice: string;
  apiKey: string;
  instructions?: string;
  callbacks: RealtimeVoiceSessionCallbacks;
}

export interface RealtimeVoiceAvailability {
  available: boolean;
  reason?: string;
}
