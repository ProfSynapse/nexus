import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import type { LiveVoiceComposerState } from '../../ui/chat/types/LiveVoiceTypes';

export interface RealtimeVoiceSessionCallbacks {
  onStateChange: (state: Exclude<LiveVoiceComposerState, 'inactive' | 'error'>) => void;
  onError: (message: string, error?: unknown) => void;
  onUserTranscript?: (text: string) => void;
  onAssistantTranscriptDelta?: (text: string) => void;
  onAssistantTranscriptCompleted?: (text: string) => void;
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

interface BaseResolvedRealtimeVoiceSessionRequest {
  provider: 'openai' | 'google';
  model: string;
  voice: string;
  apiKey: string;
  instructions?: string;
  callbacks: RealtimeVoiceSessionCallbacks;
}

export interface ResolvedOpenAIRealtimeVoiceSessionRequest extends BaseResolvedRealtimeVoiceSessionRequest {
  provider: 'openai';
}

export interface ResolvedGoogleRealtimeVoiceSessionRequest extends BaseResolvedRealtimeVoiceSessionRequest {
  provider: 'google';
}

export type ResolvedRealtimeVoiceSessionRequest =
  | ResolvedOpenAIRealtimeVoiceSessionRequest
  | ResolvedGoogleRealtimeVoiceSessionRequest;

export interface RealtimeVoiceSelection {
  provider: 'openai' | 'google' | 'elevenlabs';
  model: string;
  voice: string;
}

export interface RealtimeVoiceAvailability {
  available: boolean;
  reason?: string;
}
