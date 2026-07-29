import type { App, Component } from 'obsidian';
import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';
import type { AppsSettings } from '../../../types/apps/AppTypes';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import { RealtimeVoiceService } from '../../../services/realtimeVoice/RealtimeVoiceService';
import type { RealtimeVoiceSession } from '../../../services/realtimeVoice/RealtimeVoiceSessionTypes';
import { SpeechSynthesisService } from '../../../services/readAloud/SpeechSynthesisService';
import {
  BrowserAudioPlaybackFactory,
  type AudioPlaybackFactory,
  type AudioPlaybackHandle,
} from '../../../services/readAloud/ReadAloudService';
import type { ChatInput } from '../components/ChatInput';
import type { ToolStatusBar } from '../components/ToolStatusBar';
import type { LiveVoiceComposerState } from '../types/LiveVoiceTypes';
import { ManagedTimeoutTracker } from '../utils/ManagedTimeoutTracker';

type PluginWithLLMSettings = {
  settings?: {
    settings?: {
      llmProviders?: LLMProviderSettings;
      apps?: AppsSettings;
    };
  };
};

type LiveVoiceSpeechService = Pick<SpeechSynthesisService, 'resolveRequest' | 'synthesize'>;

export interface ChatLiveVoiceControllerOptions {
  app: App;
  chatInput: ChatInput;
  toolStatusBar: ToolStatusBar;
  liveVoiceButton: HTMLElement;
  getHasConversation: () => boolean;
  getLLMSettings?: () => LLMProviderSettings | null;
  getAppsSettings?: () => AppsSettings | undefined;
  getConversationContext?: () => string;
  onTranscriptMessage?: (role: 'user' | 'assistant', content: string) => void | Promise<void>;
  onComposedUserTurn?: (content: string) => Promise<string>;
  onAbortComposedTurn?: () => void | Promise<void>;
  createSpeechService?: (settings: LLMProviderSettings | null, appsSettings?: AppsSettings) => LiveVoiceSpeechService;
  playbackFactory?: AudioPlaybackFactory;
  component: Component;
}

const LIVE_STATUS: Record<Exclude<LiveVoiceComposerState, 'inactive'>, { text: string; state: 'present' | 'failed' }> = {
  connecting: { text: 'Connecting live voice...', state: 'present' },
  listening: { text: 'Listening', state: 'present' },
  'user-speaking': { text: 'Transcribing your speech...', state: 'present' },
  'assistant-speaking': { text: 'Nexus is speaking...', state: 'present' },
  error: { text: 'Live voice failed to start.', state: 'failed' },
};

export class ChatLiveVoiceController {
  private state: LiveVoiceComposerState = 'inactive';
  private readonly timeouts: ManagedTimeoutTracker;
  private session: RealtimeVoiceSession | null = null;
  private starting = false;
  private assistantTranscriptBuffer = '';
  private speechService: LiveVoiceSpeechService | null = null;
  private playback: AudioPlaybackHandle | null = null;
  private composedTurnGeneration = 0;
  private composedTurnActive = false;

  constructor(private readonly options: ChatLiveVoiceControllerOptions) {
    this.timeouts = new ManagedTimeoutTracker(options.component);
    options.component.registerDomEvent(options.liveVoiceButton, 'click', () => {
      void this.start();
    });
  }

  async start(): Promise<void> {
    if (this.starting || this.session) {
      return;
    }

    if (!this.options.getHasConversation()) {
      this.options.toolStatusBar.pushLiveVoiceStatus('Select or create a conversation to use live voice.', 'failed');
      return;
    }

    this.timeouts.clear();
    this.starting = true;
    this.setState('connecting');

    try {
      const llmSettings = this.getLLMSettings();
      const service = new RealtimeVoiceService(llmSettings);
      const availability = service.getAvailability();
      if (!availability.available) {
        throw new Error(availability.reason ?? 'Live voice is unavailable.');
      }

      const session = service.createSession({
        instructions: this.buildSessionInstructions(),
        callbacks: {
          onStateChange: (state) => this.setState(state),
          onError: (message, error) => this.handleSessionError(message, error),
          onSpeechStarted: () => this.handleSpeechStarted(),
          onUserTranscript: (text) => this.handleUserTranscript(text),
          onAssistantTranscriptDelta: (text) => this.handleAssistantTranscriptDelta(text),
          onAssistantTranscriptCompleted: (text) => this.handleAssistantTranscriptCompleted(text),
        },
      });
      this.session = session;
      if (session.mode === 'composed') {
        this.prepareComposedPipeline(llmSettings);
      }
      await session.start();
    } catch (error) {
      this.session?.stop();
      this.session = null;
      this.handleSessionError(
        error instanceof Error ? error.message : 'Live voice failed to start.',
        error
      );
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.starting = false;
    this.timeouts.clear();
    this.assistantTranscriptBuffer = '';
    this.composedTurnGeneration += 1;
    this.composedTurnActive = false;
    this.playback?.stop();
    this.playback = null;
    this.speechService = null;
    this.session?.stop();
    this.session = null;
    this.setState('inactive');
    this.options.toolStatusBar.clearLiveVoiceStatus();
  }

  getState(): LiveVoiceComposerState {
    return this.state;
  }

  cleanup(): void {
    this.timeouts.clear();
    this.assistantTranscriptBuffer = '';
    this.composedTurnGeneration += 1;
    this.composedTurnActive = false;
    this.playback?.stop();
    this.playback = null;
    this.speechService = null;
    this.session?.stop();
    this.session = null;
    this.setState('inactive');
  }

  private handleSessionError(message: string, error?: unknown): void {
    console.error('[ChatLiveVoiceController] Live voice error:', error ?? message);
    this.composedTurnGeneration += 1;
    this.composedTurnActive = false;
    this.playback?.stop();
    this.playback = null;
    this.session?.stop();
    this.session = null;
    this.setState('error', message);
  }

  private handleUserTranscript(text: string): void {
    const normalized = this.normalizeTranscript(text);
    if (!normalized) {
      return;
    }

    this.options.toolStatusBar.pushLiveVoiceStatus(`Heard: ${normalized}`, 'present');

    if (this.session?.mode === 'composed') {
      void this.runComposedTurn(normalized);
      return;
    }

    void this.options.onTranscriptMessage?.('user', normalized);
  }

  private handleAssistantTranscriptDelta(text: string): void {
    this.assistantTranscriptBuffer += text;
    this.setState('assistant-speaking');
  }

  private handleAssistantTranscriptCompleted(text: string): void {
    const normalized = this.normalizeTranscript(text || this.assistantTranscriptBuffer);
    this.assistantTranscriptBuffer = '';
    if (!normalized) {
      return;
    }

    void this.options.onTranscriptMessage?.('assistant', normalized);
    this.setState('listening');
  }

  private getLLMSettings(): LLMProviderSettings | null {
    const resolved = this.options.getLLMSettings?.();
    if (resolved) {
      return resolved;
    }

    const plugin = getNexusPlugin(this.options.app) as PluginWithLLMSettings | null;
    return plugin?.settings?.settings?.llmProviders ?? null;
  }

  private getAppsSettings(): AppsSettings | undefined {
    const resolved = this.options.getAppsSettings?.();
    if (resolved) {
      return resolved;
    }

    const plugin = getNexusPlugin(this.options.app) as PluginWithLLMSettings | null;
    return plugin?.settings?.settings?.apps;
  }

  private prepareComposedPipeline(llmSettings: LLMProviderSettings | null): void {
    if (!this.options.onComposedUserTurn) {
      throw new Error('The composed live voice chat pipeline is unavailable in this view.');
    }

    const createSpeechService = this.options.createSpeechService
      ?? ((settings: LLMProviderSettings | null, appsSettings?: AppsSettings) => (
        new SpeechSynthesisService(settings, { appsSettings })
      ));
    this.speechService = createSpeechService(llmSettings, this.getAppsSettings());
    this.speechService.resolveRequest({ text: 'Live voice availability check.' });
    this.playback = (this.options.playbackFactory ?? new BrowserAudioPlaybackFactory()).create();
  }

  private handleSpeechStarted(): void {
    if (this.session?.mode !== 'composed' || !this.composedTurnActive) {
      return;
    }

    this.composedTurnGeneration += 1;
    this.composedTurnActive = false;
    this.playback?.stop();
    void Promise.resolve(this.options.onAbortComposedTurn?.()).catch((error) => {
      console.error('[ChatLiveVoiceController] Failed to interrupt the active voice turn:', error);
    });
  }

  private async runComposedTurn(userTranscript: string): Promise<void> {
    if (!this.options.onComposedUserTurn || !this.speechService || !this.playback) {
      this.handleSessionError('The composed live voice pipeline is not initialized.');
      return;
    }

    const generation = ++this.composedTurnGeneration;
    this.composedTurnActive = true;

    try {
      const assistantText = this.normalizeTranscript(
        await this.options.onComposedUserTurn(userTranscript)
      );
      if (generation !== this.composedTurnGeneration) {
        return;
      }
      if (!assistantText) {
        throw new Error('The chat model returned an empty response.');
      }

      this.session?.updateAgentContext?.(assistantText);
      const speech = await this.speechService.synthesize({ text: assistantText });
      if (generation !== this.composedTurnGeneration) {
        return;
      }

      this.setState('assistant-speaking');
      await this.playback.play(speech.audioData, speech.mimeType);
      if (generation === this.composedTurnGeneration) {
        this.setState('listening');
      }
    } catch (error) {
      if (generation !== this.composedTurnGeneration) {
        return;
      }
      this.handleSessionError(
        error instanceof Error ? error.message : 'The composed live voice response failed.',
        error
      );
    } finally {
      if (generation === this.composedTurnGeneration) {
        this.composedTurnActive = false;
      }
    }
  }

  private normalizeTranscript(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  private buildSessionInstructions(): string {
    const context = this.options.getConversationContext?.().trim();
    const baseInstructions = [
      'You are Nexus, a helpful voice assistant inside Obsidian.',
      'Keep spoken responses concise and practical.',
      'When the user asks about prior chat context, use the provided conversation context instead of saying you cannot see it.',
    ].join(' ');

    return context
      ? `${baseInstructions}\n\n${context}`
      : baseInstructions;
  }

  setState(state: LiveVoiceComposerState, statusText?: string): void {
    this.state = state;
    this.options.chatInput.setLiveVoiceState(state);
    if (state === 'inactive') {
      this.options.liveVoiceButton.removeClass('chat-live-voice-button-active');
    } else {
      this.options.liveVoiceButton.addClass('chat-live-voice-button-active');
    }
    this.options.liveVoiceButton.setAttribute(
      'aria-label',
      state === 'inactive' ? 'Start live voice' : 'Live voice active'
    );
    this.options.liveVoiceButton.setAttribute(
      'title',
      state === 'inactive' ? 'Start live voice' : 'Live voice active'
    );

    if (state === 'inactive') {
      return;
    }

    const status = LIVE_STATUS[state];
    this.options.toolStatusBar.pushLiveVoiceStatus(statusText || status.text, status.state);
  }
}
