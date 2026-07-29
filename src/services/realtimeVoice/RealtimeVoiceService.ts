import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import {
  buildRealtimeVoiceProviderAvailability,
  getRealtimeVoiceModel,
  resolveDefaultRealtimeVoiceSelection,
} from '../llm/types/RealtimeVoiceTypes';
import { OpenAIRealtimeVoiceSession } from './OpenAIRealtimeVoiceSession';
import { GoogleRealtimeVoiceSession } from './GoogleRealtimeVoiceSession';
import { AssemblyAIRealtimeVoiceSession } from './AssemblyAIRealtimeVoiceSession';
import type {
  RealtimeVoiceAvailability,
  RealtimeVoiceSession,
  RealtimeVoiceSessionRequest,
  RealtimeVoiceSelection,
  ResolvedRealtimeVoiceSessionRequest,
} from './RealtimeVoiceSessionTypes';

export class RealtimeVoiceService {
  constructor(private readonly llmSettings: LLMProviderSettings | null) {}

  getAvailability(): RealtimeVoiceAvailability {
    const selection = this.resolveSelection();
    if (!selection) {
      return { available: false, reason: 'No realtime voice provider/model is configured.' };
    }

    return this.getProviderAvailability(selection);
  }

  createSession(request: Omit<RealtimeVoiceSessionRequest, 'llmSettings'>): RealtimeVoiceSession {
    const resolved = this.resolveRequest(request);
    if (resolved.provider === 'google') {
      return new GoogleRealtimeVoiceSession(resolved);
    }
    if (resolved.provider === 'assemblyai') {
      return new AssemblyAIRealtimeVoiceSession(resolved);
    }

    return new OpenAIRealtimeVoiceSession(resolved);
  }

  private resolveRequest(
    request: Omit<RealtimeVoiceSessionRequest, 'llmSettings'>
  ): ResolvedRealtimeVoiceSessionRequest {
    const selection = this.resolveSelection();
    if (!selection) {
      throw new Error('No realtime voice provider/model is configured.');
    }

    const availability = this.getProviderAvailability(selection);
    if (!availability.available) {
      throw new Error(availability.reason ?? `Realtime voice provider "${selection.provider}" is unavailable.`);
    }

    if (selection.provider === 'google') {
      return {
        provider: 'google',
        model: selection.model,
        voice: selection.voice,
        apiKey: this.getGoogleApiKey(),
        instructions: request.instructions,
        callbacks: request.callbacks,
      };
    }

    if (selection.provider === 'assemblyai') {
      return {
        provider: 'assemblyai',
        model: selection.model,
        voice: '',
        apiKey: this.getAssemblyAIApiKey(),
        instructions: request.instructions,
        callbacks: request.callbacks,
      };
    }

    if (selection.provider !== 'openai') {
      throw new Error(`Realtime voice provider "${selection.provider}" is not wired yet.`);
    }

    return {
      provider: 'openai',
      model: selection.model,
      voice: selection.voice,
      apiKey: this.getOpenAIApiKey(),
      instructions: request.instructions,
      callbacks: request.callbacks,
    };
  }

  private resolveSelection(): RealtimeVoiceSelection | null {
    const availability = buildRealtimeVoiceProviderAvailability(this.llmSettings);
    const selection = resolveDefaultRealtimeVoiceSelection(this.llmSettings, availability);
    if (selection.status !== 'resolved' || !selection.provider || !selection.model) {
      return null;
    }

    const declaration = getRealtimeVoiceModel(selection.provider, selection.model);
    return {
      provider: selection.provider,
      model: selection.model,
      voice: selection.voice || declaration?.defaultVoice || (selection.provider === 'assemblyai' ? '' : 'marin'),
    };
  }

  private getProviderAvailability(selection: RealtimeVoiceSelection): RealtimeVoiceAvailability {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return { available: false, reason: 'Microphone capture is not available in this Obsidian environment.' };
    }

    if (selection.provider === 'elevenlabs') {
      return {
        available: false,
        reason: 'Realtime voice provider "elevenlabs" is configured, but only OpenAI WebRTC and Google Live are wired in this build.',
      };
    }

    if (selection.provider === 'assemblyai') {
      if (!this.getAssemblyAIApiKey()) {
        return { available: false, reason: 'AssemblyAI is not enabled and configured for live voice.' };
      }

      if (typeof WebSocket === 'undefined') {
        return { available: false, reason: 'WebSocket is not available in this Obsidian environment.' };
      }

      if (typeof AudioContext === 'undefined') {
        return { available: false, reason: 'AudioContext is not available in this Obsidian environment.' };
      }

      return { available: true };
    }

    if (selection.provider === 'google') {
      if (!this.getGoogleApiKey()) {
        return { available: false, reason: 'Google is not enabled and configured for live voice.' };
      }

      if (typeof WebSocket === 'undefined') {
        return { available: false, reason: 'WebSocket is not available in this Obsidian environment.' };
      }

      if (typeof AudioContext === 'undefined') {
        return { available: false, reason: 'AudioContext is not available in this Obsidian environment.' };
      }

      return { available: true };
    }

    if (!this.getOpenAIApiKey()) {
      return { available: false, reason: 'OpenAI is not enabled and configured for live voice.' };
    }

    if (typeof RTCPeerConnection === 'undefined') {
      return { available: false, reason: 'WebRTC is not available in this Obsidian environment.' };
    }

    return { available: true };
  }

  private getOpenAIApiKey(): string {
    const config = this.llmSettings?.providers.openai;
    if (!config?.enabled) {
      return '';
    }

    return config.apiKey?.trim() ?? '';
  }

  private getGoogleApiKey(): string {
    const config = this.llmSettings?.providers.google;
    if (!config?.enabled) {
      return '';
    }

    return config.apiKey?.trim() ?? '';
  }

  private getAssemblyAIApiKey(): string {
    const config = this.llmSettings?.providers.assemblyai;
    if (!config?.enabled) {
      return '';
    }

    return config.apiKey?.trim() ?? '';
  }
}
