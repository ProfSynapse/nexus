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
  private keyboardViewportRoot: HTMLElement | null = null;
  private keyboardViewportFrame: number | null = null;
  private keyboardViewportCleanup: (() => void) | null = null;
  private keyboardViewportTimers: number[] = [];
  private nativeKeyboardOffset = 0;
  private keyboardViewportBaselineHeight = 0;
  private keyboardEditorHeight = 0;

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
    const focusHandler = () => {
      setTimeout(() => {
        this.updateKeyboardViewportOffset();
        this.inputElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 300);
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
    this.inputElement.style.removeProperty('height');

    // Set height limits - matches CSS min/max heights
    const keyboardActive = isMobile() && this.keyboardViewportRoot?.hasClass('chat-keyboard-active');
    const visualHeight = window.visualViewport?.height ?? window.innerHeight;
    const keyboardMinHeight = this.keyboardEditorHeight > 0
      ? this.keyboardEditorHeight
      : Math.min(280, Math.max(185, Math.round(visualHeight * 0.42)));
    const keyboardMaxHeight = this.keyboardEditorHeight > 0
      ? this.keyboardEditorHeight
      : Math.min(320, Math.max(235, Math.round(visualHeight * 0.54)));
    const minHeight = keyboardActive ? keyboardMinHeight : isMobile() ? 64 : 72;
    const maxHeight = keyboardActive ? keyboardMaxHeight : isMobile() ? 160 : 200;
    const newHeight = Math.min(Math.max(this.inputElement.scrollHeight, minHeight), maxHeight);

    // Set specific height
    this.inputElement.style.setProperty('height', newHeight + 'px');

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
    if (this.keyboardViewportFrame !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this.keyboardViewportFrame);
      this.keyboardViewportFrame = null;
    }

    this.clearKeyboardViewportTimers();
    this.keyboardViewportCleanup?.();
    this.keyboardViewportCleanup = null;
    this.nativeKeyboardOffset = 0;
    this.resetKeyboardViewportOffset();
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
    if (!this.component || typeof window === 'undefined') {
      return;
    }

    this.keyboardViewportCleanup?.();
    this.keyboardViewportRoot = this.container.closest('.chat-main');
    this.keyboardViewportBaselineHeight = window.innerHeight;
    if (!this.keyboardViewportRoot) {
      return;
    }

    const scheduleUpdate = () => this.scheduleKeyboardViewportOffsetUpdate();
    const scheduleSettledUpdates = () => this.scheduleKeyboardViewportSettledUpdates();
    const handleNativeKeyboardShow = (event: CapacitorKeyboardEvent) => {
      this.updateNativeKeyboardOffset(event);
      this.scheduleKeyboardViewportSettledUpdates();
    };
    const handleNativeKeyboardHide = () => {
      this.nativeKeyboardOffset = 0;
      this.clearKeyboardViewportTimers();
      window.setTimeout(() => {
        this.keyboardViewportBaselineHeight = window.innerHeight;
        this.resetKeyboardViewportOffset();
      }, 160);
    };
    const clearOffset = () => {
      window.setTimeout(() => {
        if (!this.inputElement?.matches(':focus')) {
          if (this.sendButton && document.activeElement === this.sendButton) {
            this.sendButton.blur();
          }
          this.nativeKeyboardOffset = 0;
          this.keyboardViewportBaselineHeight = window.innerHeight;
          this.resetKeyboardViewportOffset();
        }
      }, 120);
    };

    window.visualViewport?.addEventListener('resize', scheduleSettledUpdates);
    window.visualViewport?.addEventListener('scroll', scheduleUpdate);

    const cleanup = () => {
      window.visualViewport?.removeEventListener('resize', scheduleSettledUpdates);
      window.visualViewport?.removeEventListener('scroll', scheduleUpdate);
      this.clearKeyboardViewportTimers();
      this.resetKeyboardViewportOffset();
    };
    this.keyboardViewportCleanup = cleanup;
    this.component.register(cleanup);

    this.component.registerDomEvent(this.inputElement as HTMLElement, 'focus', scheduleSettledUpdates);
    this.component.registerDomEvent(this.inputElement as HTMLElement, 'blur', clearOffset);
    this.component.registerDomEvent(window, 'resize', scheduleSettledUpdates);
    this.component.registerDomEvent(window, 'orientationchange', scheduleSettledUpdates);
    this.component.registerDomEvent(window, 'keyboardWillShow', handleNativeKeyboardShow);
    this.component.registerDomEvent(window, 'keyboardDidShow', handleNativeKeyboardShow);
    this.component.registerDomEvent(window, 'keyboardWillHide', handleNativeKeyboardHide);
    this.component.registerDomEvent(window, 'keyboardDidHide', handleNativeKeyboardHide);
    this.updateKeyboardViewportOffset();
  }

  private scheduleKeyboardViewportSettledUpdates(): void {
    this.clearKeyboardViewportTimers();
    this.scheduleKeyboardViewportOffsetUpdate();

    for (const delay of [60, 180, 320]) {
      const timer = window.setTimeout(() => {
        this.keyboardViewportTimers = this.keyboardViewportTimers.filter((timerId) => timerId !== timer);
        this.scheduleKeyboardViewportOffsetUpdate();
      }, delay);
      this.keyboardViewportTimers.push(timer);
    }
  }

  private scheduleKeyboardViewportOffsetUpdate(): void {
    if (this.keyboardViewportFrame !== null) {
      window.cancelAnimationFrame(this.keyboardViewportFrame);
    }

    this.keyboardViewportFrame = window.requestAnimationFrame(() => {
      this.keyboardViewportFrame = null;
      this.updateKeyboardViewportOffset();
    });
  }

  private updateKeyboardViewportOffset(): void {
    if (!this.keyboardViewportRoot || typeof window === 'undefined') {
      return;
    }

    const currentOffset = this.getCurrentKeyboardOffset();
    const inputBottom = this.container.getBoundingClientRect().bottom + currentOffset;
    const keyboardTop = this.getKeyboardTop();
    const visualViewportOffset = keyboardTop !== null
      ? Math.max(0, inputBottom - keyboardTop)
      : 0;
    const keyboardOffset = visualViewportOffset > 1 ? visualViewportOffset : this.nativeKeyboardOffset;
    const roundedOffset = Math.ceil(keyboardOffset);

    if (roundedOffset > 1) {
      this.keyboardViewportRoot.addClass('chat-keyboard-active');
      const liftOffset = Math.max(0, roundedOffset - 22);
      this.keyboardViewportRoot.style.setProperty('--chat-keyboard-offset', `${liftOffset}px`);
      this.updateKeyboardEditorHeight(keyboardTop);
      this.autoResizeInput();
    } else {
      this.resetKeyboardViewportOffset();
    }
  }

  private resetKeyboardViewportOffset(): void {
    this.keyboardViewportRoot?.removeClass('chat-keyboard-active');
    this.keyboardViewportRoot?.style.removeProperty('--chat-keyboard-offset');
    this.keyboardViewportRoot?.style.removeProperty('--chat-keyboard-editor-height');
    this.keyboardEditorHeight = 0;
    this.autoResizeInput();
  }

  private updateNativeKeyboardOffset(event: CapacitorKeyboardEvent): void {
    const keyboardHeight = this.getKeyboardHeight(event);
    if (keyboardHeight <= 0 || typeof window === 'undefined') {
      this.nativeKeyboardOffset = 0;
      return;
    }

    if (this.keyboardViewportBaselineHeight <= 0) {
      this.keyboardViewportBaselineHeight = window.innerHeight;
    }

    const layoutResizeAmount = Math.max(0, this.keyboardViewportBaselineHeight - window.innerHeight);
    this.nativeKeyboardOffset = Math.max(0, keyboardHeight - layoutResizeAmount);
  }

  private getKeyboardHeight(event: CapacitorKeyboardEvent): number {
    const directHeight = event.keyboardHeight;
    if (typeof directHeight === 'number' && Number.isFinite(directHeight)) {
      return Math.round(directHeight);
    }

    const detailHeight = event.detail?.keyboardHeight;
    if (typeof detailHeight === 'number' && Number.isFinite(detailHeight)) {
      return Math.round(detailHeight);
    }

    return 0;
  }

  private clearKeyboardViewportTimers(): void {
    if (typeof window === 'undefined') {
      this.keyboardViewportTimers = [];
      return;
    }

    for (const timer of this.keyboardViewportTimers) {
      window.clearTimeout(timer);
    }
    this.keyboardViewportTimers = [];
  }

  private getCurrentKeyboardOffset(): number {
    if (!this.keyboardViewportRoot) {
      return 0;
    }

    const rawOffset = window.getComputedStyle(this.keyboardViewportRoot).getPropertyValue('--chat-keyboard-offset');
    const parsedOffset = Number.parseFloat(rawOffset);
    return Number.isFinite(parsedOffset) ? parsedOffset : 0;
  }

  private getKeyboardTop(): number | null {
    if (!this.keyboardViewportRoot || typeof window === 'undefined') {
      return null;
    }

    if (window.visualViewport) {
      return window.visualViewport.height + window.visualViewport.offsetTop;
    }

    if (this.nativeKeyboardOffset > 0) {
      return this.keyboardViewportRoot.getBoundingClientRect().bottom - this.nativeKeyboardOffset;
    }

    return null;
  }

  private updateKeyboardEditorHeight(keyboardTop: number | null): void {
    if (!this.keyboardViewportRoot || keyboardTop === null) {
      this.keyboardEditorHeight = 0;
      this.keyboardViewportRoot?.style.removeProperty('--chat-keyboard-editor-height');
      return;
    }

    const header = this.keyboardViewportRoot.querySelector('.chat-header');
    const branchHeaderContainer = this.keyboardViewportRoot.querySelector('.nexus-branch-header-container');
    const statusBarContainer = this.keyboardViewportRoot.querySelector('.tool-status-bar-container');

    const headerBottom = header?.getBoundingClientRect().bottom ?? this.keyboardViewportRoot.getBoundingClientRect().top;
    const branchBottom = branchHeaderContainer && branchHeaderContainer.childElementCount > 0
      ? branchHeaderContainer.getBoundingClientRect().bottom
      : headerBottom;
    const topBoundary = Math.max(headerBottom, branchBottom);
    const statusHeight = statusBarContainer?.getBoundingClientRect().height ?? 0;
    const availableHeight = keyboardTop - topBoundary - statusHeight - 18;
    const clampedHeight = Math.max(150, Math.min(320, Math.round(availableHeight)));

    this.keyboardEditorHeight = clampedHeight;
    this.keyboardViewportRoot.style.setProperty('--chat-keyboard-editor-height', `${clampedHeight}px`);
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
