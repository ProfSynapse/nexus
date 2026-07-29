import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import type { LiveVoiceComposerState } from '../../ui/chat/types/LiveVoiceTypes';

export interface RealtimeVoiceSessionCallbacks {
  onStateChange: (state: Exclude<LiveVoiceComposerState, 'inactive' | 'error'>) => void;
  onError: (message: string, error?: unknown) => void;
  onSpeechStarted?: () => void;
  onUserTranscript?: (text: string) => void;
  onAssistantTranscriptDelta?: (text: string) => void;
  onAssistantTranscriptCompleted?: (text: string) => void;
}

export interface RealtimeVoiceSession {
  readonly mode?: 'native' | 'composed';
  start(): Promise<void>;
  stop(): void;
  updateAgentContext?(text: string): void;
}

export interface RealtimeVoiceSessionRequest {
  llmSettings: LLMProviderSettings | null;
  instructions?: string;
  callbacks: RealtimeVoiceSessionCallbacks;
}

interface BaseResolvedRealtimeVoiceSessionRequest {
  provider: 'openai' | 'google' | 'assemblyai';
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

export interface ResolvedAssemblyAIRealtimeVoiceSessionRequest extends BaseResolvedRealtimeVoiceSessionRequest {
  provider: 'assemblyai';
}

export type ResolvedRealtimeVoiceSessionRequest =
  | ResolvedOpenAIRealtimeVoiceSessionRequest
  | ResolvedGoogleRealtimeVoiceSessionRequest
  | ResolvedAssemblyAIRealtimeVoiceSessionRequest;

export interface RealtimeVoiceSelection {
  provider: 'openai' | 'google' | 'assemblyai' | 'elevenlabs';
  model: string;
  voice: string;
}

export interface RealtimeVoiceAvailability {
  available: boolean;
  reason?: string;
}
