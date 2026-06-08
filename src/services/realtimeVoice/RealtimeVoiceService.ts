import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import {
  buildRealtimeVoiceProviderAvailability,
  getRealtimeVoiceModel,
  resolveDefaultRealtimeVoiceSelection,
} from '../llm/types/RealtimeVoiceTypes';
import { OpenAIRealtimeVoiceSession } from './OpenAIRealtimeVoiceSession';
import type {
  RealtimeVoiceAvailability,
  RealtimeVoiceSession,
  RealtimeVoiceSessionRequest,
  ResolvedRealtimeVoiceSessionRequest,
} from './RealtimeVoiceSessionTypes';

export class RealtimeVoiceService {
  constructor(private readonly llmSettings: LLMProviderSettings | null) {}

  getAvailability(): RealtimeVoiceAvailability {
    const selection = this.resolveSelection();
    if (!selection) {
      return { available: false, reason: 'No realtime voice provider/model is configured.' };
    }

    if (selection.provider !== 'openai') {
      return {
        available: false,
        reason: `Realtime voice provider "${selection.provider}" is configured, but only OpenAI WebRTC is wired in this build.`,
      };
    }

    if (!this.getOpenAIApiKey()) {
      return { available: false, reason: 'OpenAI is not enabled and configured for live voice.' };
    }

    if (typeof RTCPeerConnection === 'undefined') {
      return { available: false, reason: 'WebRTC is not available in this Obsidian environment.' };
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return { available: false, reason: 'Microphone capture is not available in this Obsidian environment.' };
    }

    return { available: true };
  }

  createSession(request: Omit<RealtimeVoiceSessionRequest, 'llmSettings'>): RealtimeVoiceSession {
    const resolved = this.resolveRequest(request);
    return new OpenAIRealtimeVoiceSession(resolved);
  }

  private resolveRequest(
    request: Omit<RealtimeVoiceSessionRequest, 'llmSettings'>
  ): ResolvedRealtimeVoiceSessionRequest {
    const selection = this.resolveSelection();
    if (!selection) {
      throw new Error('No realtime voice provider/model is configured.');
    }

    if (selection.provider !== 'openai') {
      throw new Error(`Realtime voice provider "${selection.provider}" is not wired yet.`);
    }

    const apiKey = this.getOpenAIApiKey();
    if (!apiKey) {
      throw new Error('OpenAI is not enabled and configured for live voice.');
    }

    return {
      provider: 'openai',
      model: selection.model,
      voice: selection.voice,
      apiKey,
      instructions: request.instructions,
      callbacks: request.callbacks,
    };
  }

  private resolveSelection(): { provider: string; model: string; voice: string } | null {
    const availability = buildRealtimeVoiceProviderAvailability(this.llmSettings);
    const selection = resolveDefaultRealtimeVoiceSelection(this.llmSettings, availability);
    if (selection.status !== 'resolved' || !selection.provider || !selection.model) {
      return null;
    }

    const declaration = getRealtimeVoiceModel(selection.provider, selection.model);
    return {
      provider: selection.provider,
      model: selection.model,
      voice: selection.voice || declaration?.defaultVoice || 'marin',
    };
  }

  private getOpenAIApiKey(): string {
    const config = this.llmSettings?.providers.openai;
    if (!config?.enabled) {
      return '';
    }

    return config.apiKey?.trim() ?? '';
  }
}
