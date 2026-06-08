import type { Component } from 'obsidian';
import type { ChatInput } from '../components/ChatInput';
import type { ToolStatusBar } from '../components/ToolStatusBar';
import type { LiveVoiceComposerState } from '../types/LiveVoiceTypes';
import { ManagedTimeoutTracker } from '../utils/ManagedTimeoutTracker';

export interface ChatLiveVoiceControllerOptions {
  chatInput: ChatInput;
  toolStatusBar: ToolStatusBar;
  liveVoiceButton: HTMLElement;
  getHasConversation: () => boolean;
  component: Component;
}

const LIVE_STATUS: Record<Exclude<LiveVoiceComposerState, 'inactive'>, { text: string; state: 'present' | 'failed' }> = {
  connecting: { text: 'Connecting live voice...', state: 'present' },
  listening: { text: 'Listening', state: 'present' },
  'user-speaking': { text: 'Transcribing your speech...', state: 'present' },
  'assistant-speaking': { text: 'Nexus is speaking...', state: 'present' },
  error: { text: 'Live voice provider is not connected yet.', state: 'failed' },
};

export class ChatLiveVoiceController {
  private state: LiveVoiceComposerState = 'inactive';
  private readonly timeouts: ManagedTimeoutTracker;

  constructor(private readonly options: ChatLiveVoiceControllerOptions) {
    this.timeouts = new ManagedTimeoutTracker(options.component);
    options.component.registerDomEvent(options.liveVoiceButton, 'click', () => {
      this.start();
    });
  }

  start(): void {
    if (!this.options.getHasConversation()) {
      this.options.toolStatusBar.pushLiveVoiceStatus('Select or create a conversation to use live voice.', 'failed');
      return;
    }

    this.setState('connecting');
    this.timeouts.schedule(() => {
      if (this.state === 'connecting') {
        this.setState('error');
      }
    }, 700);
  }

  stop(): void {
    this.timeouts.clear();
    this.setState('inactive');
    this.options.toolStatusBar.clearLiveVoiceStatus();
  }

  getState(): LiveVoiceComposerState {
    return this.state;
  }

  setState(state: LiveVoiceComposerState): void {
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
    this.options.toolStatusBar.pushLiveVoiceStatus(status.text, status.state);
  }

  cleanup(): void {
    this.timeouts.clear();
    this.options.chatInput.setLiveVoiceState('inactive');
  }
}
