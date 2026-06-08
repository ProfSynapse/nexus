import type { App, Component } from 'obsidian';
import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import { RealtimeVoiceService } from '../../../services/realtimeVoice/RealtimeVoiceService';
import type { RealtimeVoiceSession } from '../../../services/realtimeVoice/RealtimeVoiceSessionTypes';
import type { ChatInput } from '../components/ChatInput';
import type { ToolStatusBar } from '../components/ToolStatusBar';
import type { LiveVoiceComposerState } from '../types/LiveVoiceTypes';
import { ManagedTimeoutTracker } from '../utils/ManagedTimeoutTracker';

type PluginWithLLMSettings = {
  settings?: {
    settings?: {
      llmProviders?: LLMProviderSettings;
    };
  };
};

export interface ChatLiveVoiceControllerOptions {
  app: App;
  chatInput: ChatInput;
  toolStatusBar: ToolStatusBar;
  liveVoiceButton: HTMLElement;
  getHasConversation: () => boolean;
  onTranscriptMessage?: (role: 'user' | 'assistant', content: string) => void | Promise<void>;
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
      const service = new RealtimeVoiceService(this.getLLMSettings());
      const availability = service.getAvailability();
      if (!availability.available) {
        throw new Error(availability.reason ?? 'Live voice is unavailable.');
      }

      const session = service.createSession({
        instructions: 'You are Nexus, a helpful voice assistant inside Obsidian. Keep spoken responses concise and practical.',
        callbacks: {
          onStateChange: (state) => this.setState(state),
          onError: (message, error) => this.handleSessionError(message, error),
          onUserTranscript: (text) => this.handleUserTranscript(text),
          onAssistantTranscriptDelta: (text) => this.handleAssistantTranscriptDelta(text),
          onAssistantTranscriptCompleted: (text) => this.handleAssistantTranscriptCompleted(text),
        },
      });
      this.session = session;
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
    this.session?.stop();
    this.session = null;
    this.setState('inactive');
  }

  private handleSessionError(message: string, error?: unknown): void {
    console.error('[ChatLiveVoiceController] Live voice error:', error ?? message);
    this.session?.stop();
    this.session = null;
    this.setState('error', message);
  }

  private handleUserTranscript(text: string): void {
    const normalized = this.normalizeTranscript(text);
    if (!normalized) {
      return;
    }

    void this.options.onTranscriptMessage?.('user', normalized);
    this.options.toolStatusBar.pushLiveVoiceStatus(`Heard: ${normalized}`, 'present');
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
    const plugin = getNexusPlugin(this.options.app) as PluginWithLLMSettings | null;
    return plugin?.settings?.settings?.llmProviders ?? null;
  }

  private normalizeTranscript(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
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
