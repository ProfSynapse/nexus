/**
 * ChatInput - Message input component with send functionality
 *
 * Provides text input, send button, and model selection
 */

import { setIcon, App, Component, Notice } from 'obsidian';
import { initializeSuggesters, SuggesterInstances } from './suggesters/initializeSuggesters';
import { ContentEditableHelper } from '../utils/ContentEditableHelper';
import { ReferenceExtractor, ReferenceMetadata } from '../utils/ReferenceExtractor';
import { MessageEnhancement } from './suggesters/base/SuggesterInterfaces';
import { MessageEnhancer } from '../services/MessageEnhancer';
import { isMobile, isIOS } from '../../../utils/platform';
import { ChatVoiceInputController, ChatVoiceInputState } from '../controllers/ChatVoiceInputController';
import { ManagedTimeoutTracker } from '../utils/ManagedTimeoutTracker';
import { ChatKeyboardViewportController } from '../controllers/ChatKeyboardViewportController';

export class ChatInput {
  private element: HTMLElement | null = null;
  private inputElement: HTMLElement | null = null;
  private inputWrapper: HTMLElement | null = null;
  private voiceVisualElement: HTMLElement | null = null;
  private sendButton: HTMLButtonElement | null = null;
  private isLoading = false;
  private isPreSendCompacting = false;
  private hasConversation = false;
  private suggesters: SuggesterInstances | null = null;
  private voiceInputState: ChatVoiceInputState = 'idle';
  private voiceInputController: ChatVoiceInputController | null = null;
  private voiceVisualResizeObserver: ResizeObserver | null = null;
  private timeouts: ManagedTimeoutTracker | null = null;
  private keyboardViewportController: ChatKeyboardViewportController | null = null;

  constructor(
    private container: HTMLElement,
    private onSendMessage: (
      message: string,
      enhancement?: MessageEnhancement,
      metadata?: ReferenceMetadata
    ) => void,
    private getLoadingState: () => boolean,
    private app?: App,
    private onStopGeneration?: () => void,
    private getHasConversation?: () => boolean,
    private component?: Component
  ) {
    if (component) {
      this.timeouts = new ManagedTimeoutTracker(component);
    }
    this.render();
  }

  /**
   * Set loading state
   */
  setLoading(loading: boolean): void {
    this.isLoading = loading;
    this.updateUI();
  }

  /**
   * Set pre-send compaction state.
   */
  setPreSendCompacting(compacting: boolean): void {
    this.isPreSendCompacting = compacting;
    this.updateUI();
  }

  /**
   * Set conversation state (whether a conversation is active)
   */
  setConversationState(hasConversation: boolean): void {
    this.hasConversation = hasConversation;
    this.updateUI();
  }

  /**
   * Set placeholder text
   */
  setPlaceholder(placeholder: string): void {
    if (this.inputElement) {
      this.inputElement.setAttribute('data-placeholder', placeholder);
    }
  }

  /**
   * Render the chat input interface
   */
  private render(): void {
    this.container.empty();
    this.container.addClass('chat-input');
    const component = this.component;

    // Input wrapper - contains both textarea and embedded send button
    this.inputWrapper = this.container.createDiv('chat-input-wrapper');

    // Contenteditable input
    this.inputElement = this.inputWrapper.createDiv('chat-textarea');
    this.inputElement.contentEditable = 'true';
    this.inputElement.setAttribute('data-placeholder', 'Type your message...');
    this.inputElement.setAttribute('role', 'textbox');
    this.inputElement.setAttribute('aria-multiline', 'true');

    this.voiceVisualElement = this.inputWrapper.createDiv('chat-voice-visual');
    this.voiceVisualElement.setAttribute('aria-hidden', 'true');

    // Handle Enter key (send) and Shift+Enter (new line)
    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        // Don't send if any suggester is active (let suggester handle it)
        const anySuggesterActive =
          this.suggesters?.noteSuggester?.getIsActive() ||
          this.suggesters?.toolSuggester?.getIsActive() ||
          this.suggesters?.promptSuggester?.getIsActive();

        if (!anySuggesterActive) {
          e.preventDefault();
          this.handleSendMessage();
        }
      }
    };

    // Auto-resize on input
    const inputHandler = () => {
      this.autoResizeInput();
      this.updateUI();
    };

    // iOS: keep the focused input visible while the keyboard animates.
    // The controller's own focus handler schedules settling probes at
    // 0/60/180/320ms so we only need to scroll the input into view here.
    const focusHandler = () => {
      const run = () => {
        this.inputElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
      if (this.timeouts) {
        this.timeouts.setTimeout(run, 300);
      } else {
        setTimeout(run, 300);
      }
    };

    // Register events with component for auto-cleanup
    if (component) {
      component.registerDomEvent(this.inputElement, 'keydown', keydownHandler);
      component.registerDomEvent(this.inputElement, 'input', inputHandler);
      if (isIOS()) {
        component.registerDomEvent(this.inputElement, 'focus', focusHandler);
      }
    }

    // Mobile: Add mobile-specific class for styling
    if (isMobile()) {
      this.inputWrapper.addClass('chat-input-mobile');
      this.initializeKeyboardViewportHandling();
    }

    // Send button - embedded inside the input wrapper (bottom-right)
    // Uses Obsidian's clickable-icon class for proper icon sizing
    this.sendButton = this.inputWrapper.createEl('button', {
      cls: 'chat-send-button clickable-icon'
    });

    // Add send icon using Obsidian's setIcon
    setIcon(this.sendButton, 'arrow-up');
    this.sendButton.setAttribute('aria-label', 'Send message');

    const sendClickHandler = () => {
      this.handleSendOrStop();
    };
    component?.registerDomEvent(this.sendButton, 'click', sendClickHandler);

    // Initialize suggesters if app is available
    if (this.app && this.inputElement) {
      this.suggesters = initializeSuggesters(this.app, this.inputElement, this.component);
    }

    this.voiceInputController = new ChatVoiceInputController(this.app, {
      onStateChange: (state) => {
        this.voiceInputState = state;
        this.updateVoiceVisual();
        this.updateUI();
      },
      onTranscriptReady: (text) => {
        this.setValue(text);
        this.focus();
      },
      onError: (message) => {
        new Notice(message);
      }
    });

    this.initializeVoiceVisualResizeHandling();
    this.buildVoiceBars();

    this.element = this.container;
    this.updateUI();
  }

  /**
   * Handle send or stop based on current state
   */
  private handleSendOrStop(): void {
    const actuallyLoading = this.isLoading || this.getLoadingState();
    const hasPendingInput = this.hasPendingInput();
    const canUseVoiceInput = this.canUseVoiceInput();

    if (this.voiceInputState === 'recording') {
      void this.voiceInputController?.stopRecording();
      return;
    }

    if (this.voiceInputState === 'transcribing') {
      return;
    }

    if (actuallyLoading && !hasPendingInput) {
      // Stop generation
      if (this.onStopGeneration) {
        this.onStopGeneration();
      }
    } else if (!hasPendingInput && canUseVoiceInput) {
      void this.voiceInputController?.startRecording();
    } else {
      // Send message
      this.handleSendMessage();
    }
  }

  /**
   * Handle sending a message
   */
  private handleSendMessage(): void {
    if (!this.inputElement) return;

    // Check if a conversation is active
    const hasConversation = this.getHasConversation ? this.getHasConversation() : this.hasConversation;
    if (!hasConversation) {
      return;
    }

    const extracted = ReferenceExtractor.extractContent(this.inputElement);
    const message = extracted.plainText.trim();
    if (!message) return;

    // Build enhancement from MessageEnhancer
    let enhancement: MessageEnhancement | undefined = undefined;
    if (this.suggesters?.messageEnhancer && this.suggesters.messageEnhancer.hasEnhancements()) {
      enhancement = this.suggesters.messageEnhancer.buildEnhancement(message);
    }

    const metadata: ReferenceMetadata | undefined =
      extracted.references.length > 0
        ? {
            references: extracted.references
          }
        : undefined;

    // Clear the input
    ContentEditableHelper.clear(this.inputElement);
    this.autoResizeInput();

    // Send the message with enhancement
    this.onSendMessage(message, enhancement, metadata);
  }

  /**
   * Auto-resize input based on content (limited to ~4 lines)
   */
  private autoResizeInput(): void {
    if (!this.inputElement) return;

    // Reset height to auto to get the correct scrollHeight
    this.inputElement.style.removeProperty('--chat-input-height');

    // Set height limits - matches CSS min/max heights
    const keyboardActive = isMobile() && (this.keyboardViewportController?.isActive() ?? false);
    const keyboardEditorHeight = this.keyboardViewportController?.getEditorHeight() ?? 0;
    const visualHeight = window.visualViewport?.height ?? window.innerHeight;
    const keyboardMinHeight = keyboardEditorHeight > 0
      ? keyboardEditorHeight
      : Math.min(280, Math.max(185, Math.round(visualHeight * 0.42)));
    const keyboardMaxHeight = keyboardEditorHeight > 0
      ? keyboardEditorHeight
      : Math.min(320, Math.max(235, Math.round(visualHeight * 0.54)));
    const minHeight = keyboardActive ? keyboardMinHeight : isMobile() ? 64 : 72;
    const maxHeight = keyboardActive ? keyboardMaxHeight : isMobile() ? 160 : 200;
    const newHeight = Math.min(Math.max(this.inputElement.scrollHeight, minHeight), maxHeight);

    // Write computed height as a CSS custom property consumed by styles.css
    this.inputElement.style.setProperty('--chat-input-height', newHeight + 'px');

    // Enable scrolling if content exceeds max height
    if (this.inputElement.scrollHeight > maxHeight) {
      this.inputElement.removeClass('chat-input-overflow-hidden');
      this.inputElement.addClass('chat-input-overflow-auto');
    } else {
      this.inputElement.removeClass('chat-input-overflow-auto');
      this.inputElement.addClass('chat-input-overflow-hidden');
    }
  }

  /**
   * Update UI based on current state
   */
  private updateUI(): void {
    if (!this.sendButton || !this.inputElement) return;

    const actuallyLoading = this.isLoading || this.getLoadingState();
    const hasConversation = this.getHasConversation ? this.getHasConversation() : this.hasConversation;
    const hasPendingInput = this.hasPendingInput();
    const canUseVoiceInput = this.canUseVoiceInput();
    this.inputElement.setAttribute('aria-busy', this.isPreSendCompacting ? 'true' : 'false');

    if (this.isPreSendCompacting) {
      this.container.addClass('chat-input-compacting');
    } else {
      this.container.removeClass('chat-input-compacting');
    }

    if (!hasConversation) {
      // No conversation selected - disable everything
      this.sendButton.disabled = true;
      this.sendButton.classList.remove('stop-mode');
      this.sendButton.classList.add('disabled-mode');
      this.sendButton.empty();
      setIcon(this.sendButton, 'arrow-up');
      this.sendButton.setAttribute('aria-label', 'No conversation selected');
      this.inputElement.contentEditable = 'false';
      this.inputElement.setAttribute('data-placeholder', 'Select or create a conversation to begin');
    } else if (this.isPreSendCompacting) {
      this.sendButton.disabled = true;
      this.sendButton.classList.remove('stop-mode');
      this.sendButton.classList.add('disabled-mode');
      this.sendButton.empty();
      setIcon(this.sendButton, 'arrow-up');
      this.sendButton.setAttribute('aria-label', 'Compacting');
      this.inputElement.contentEditable = 'false';
      this.inputElement.setAttribute('data-placeholder', 'Compacting');
    } else if (actuallyLoading) {
      // Keep the input active so a new message can interrupt the current turn.
      this.sendButton.disabled = false;
      this.sendButton.empty();
      this.inputElement.contentEditable = 'true';

      if (hasPendingInput) {
        this.sendButton.classList.remove('stop-mode');
        this.sendButton.classList.remove('disabled-mode');
        setIcon(this.sendButton, 'arrow-up');
        this.sendButton.setAttribute('aria-label', 'Interrupt and send message');
        this.inputElement.setAttribute('data-placeholder', 'Send a steering message...');
      } else {
        this.sendButton.classList.add('stop-mode');
        this.sendButton.classList.remove('disabled-mode');
        setIcon(this.sendButton, 'square');
        this.sendButton.setAttribute('aria-label', 'Stop generation');
        this.inputElement.setAttribute('data-placeholder', 'Type to interrupt, or stop generation');
      }
    } else if (this.voiceInputState === 'recording') {
      this.sendButton.disabled = false;
      this.sendButton.classList.add('stop-mode');
      this.sendButton.classList.remove('disabled-mode');
      this.sendButton.empty();
      setIcon(this.sendButton, 'square');
      this.sendButton.setAttribute('aria-label', 'Stop recording');
      this.inputElement.contentEditable = 'false';
      this.inputElement.setAttribute('data-placeholder', 'Type your message...');
    } else if (this.voiceInputState === 'transcribing') {
      this.sendButton.disabled = true;
      this.sendButton.classList.add('stop-mode');
      this.sendButton.classList.remove('disabled-mode');
      this.sendButton.empty();
      setIcon(this.sendButton, 'square');
      this.sendButton.setAttribute('aria-label', 'Finishing transcription');
      this.inputElement.contentEditable = 'false';
      this.inputElement.setAttribute('data-placeholder', 'Type your message...');
    } else if (!hasPendingInput && canUseVoiceInput) {
      this.sendButton.disabled = false;
      this.sendButton.classList.remove('stop-mode');
      this.sendButton.classList.remove('disabled-mode');
      this.sendButton.empty();
      setIcon(this.sendButton, 'mic');
      this.sendButton.setAttribute('aria-label', 'Start voice input');
      this.inputElement.contentEditable = 'true';
      this.inputElement.setAttribute('data-placeholder', 'Type your message...');
    } else {
      // Show normal send button
      this.sendButton.disabled = false;
      this.sendButton.classList.remove('stop-mode');
      this.sendButton.classList.remove('disabled-mode');
      this.sendButton.empty();
      setIcon(this.sendButton, 'arrow-up');
      this.sendButton.setAttribute('aria-label', 'Send message');
      this.inputElement.contentEditable = 'true';
      this.inputElement.setAttribute('data-placeholder', 'Type your message...');
    }

    this.updateVoiceVisual();
  }

  private hasPendingInput(): boolean {
    if (!this.inputElement) {
      return false;
    }

    return ContentEditableHelper.getPlainText(this.inputElement).trim().length > 0;
  }

  /**
   * Focus the input
   */
  focus(): void {
    if (this.inputElement) {
      ContentEditableHelper.focus(this.inputElement);
    }
  }

  /**
   * Clear the input
   */
  clear(): void {
    if (this.inputElement) {
      ContentEditableHelper.clear(this.inputElement);
      this.autoResizeInput();
      this.updateUI();
    }
  }

  /**
   * Get current input value
   */
  getValue(): string {
    return this.inputElement ? ContentEditableHelper.getPlainText(this.inputElement) : '';
  }

  /**
   * Set input value
   */
  setValue(value: string): void {
    if (this.inputElement) {
      ContentEditableHelper.setPlainText(this.inputElement, value);
      this.autoResizeInput();
      this.updateUI();
    }
  }

  /**
   * Get message enhancer (for accessing enhancements before sending)
   */
  getMessageEnhancer(): MessageEnhancer | null {
    return this.suggesters?.messageEnhancer || null;
  }

  /**
   * Clear message enhancer (call after message is sent)
   */
  clearMessageEnhancer(): void {
    if (this.suggesters?.messageEnhancer) {
      this.suggesters.messageEnhancer.clearEnhancements();
    }
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.keyboardViewportController?.detach();
    this.keyboardViewportController = null;
    this.voiceVisualResizeObserver?.disconnect();
    this.voiceVisualResizeObserver = null;
    this.voiceInputController?.cleanup();
    this.voiceInputController = null;

    if (this.suggesters) {
      this.suggesters.cleanup();
      this.suggesters = null;
    }

    this.element = null;
    this.inputElement = null;
    this.inputWrapper = null;
    this.voiceVisualElement = null;
    this.sendButton = null;
  }

  private initializeKeyboardViewportHandling(): void {
    if (!this.component || !this.inputElement) {
      return;
    }

    this.keyboardViewportController?.detach();
    this.keyboardViewportController = new ChatKeyboardViewportController({
      container: this.container,
      inputElement: this.inputElement,
      getSendButton: () => this.sendButton,
      onOffsetChanged: () => this.autoResizeInput(),
      component: this.component,
    });
    this.keyboardViewportController.attach();
  }

  private canUseVoiceInput(): boolean {
    return this.voiceInputController?.isAvailable() ?? false;
  }

  private updateVoiceVisual(): void {
    if (!this.inputWrapper) {
      return;
    }

    const isVoiceMode = this.voiceInputState === 'recording' || this.voiceInputState === 'transcribing';
    if (isVoiceMode) {
      this.inputWrapper.addClass('chat-input-voice-recording');
    } else {
      this.inputWrapper.removeClass('chat-input-voice-recording');
    }

    if (this.voiceInputState === 'transcribing') {
      this.inputWrapper.addClass('chat-input-voice-transcribing');
    } else {
      this.inputWrapper.removeClass('chat-input-voice-transcribing');
    }

    if (isVoiceMode) {
      this.buildVoiceBars();
    }
  }

  private initializeVoiceVisualResizeHandling(): void {
    if (!this.voiceVisualElement) {
      return;
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.voiceVisualResizeObserver = new ResizeObserver(() => this.buildVoiceBars());
      this.voiceVisualResizeObserver.observe(this.voiceVisualElement);
      return;
    }

    if (this.component && typeof window !== 'undefined') {
      this.component.registerDomEvent(window, 'resize', () => this.buildVoiceBars());
    }
  }

  private buildVoiceBars(): void {
    if (!this.voiceVisualElement || typeof window === 'undefined') {
      return;
    }

    const computedStyle = window.getComputedStyle(this.voiceVisualElement);
    const paddingLeft = Number.parseFloat(computedStyle.paddingLeft || '0');
    const paddingRight = Number.parseFloat(computedStyle.paddingRight || '0');
    const availableWidth = this.voiceVisualElement.clientWidth - paddingLeft - paddingRight;

    if (availableWidth <= 0) {
      return;
    }

    const gap = 4;
    const barWidth = 3;
    const barSlot = barWidth + gap;
    const barCount = Math.max(12, Math.floor(availableWidth / barSlot));

    this.voiceVisualElement.empty();

    for (let index = 0; index < barCount; index += 1) {
      const phaseIndex = index % 8;
      const delayIndex = index % 8;
      this.voiceVisualElement.createSpan(`chat-voice-bar chat-voice-bar-phase-${phaseIndex} chat-voice-bar-delay-${delayIndex}`);
    }
  }
}
