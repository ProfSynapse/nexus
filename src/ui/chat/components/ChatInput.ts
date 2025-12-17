/**
 * ChatInput - Message input component with send functionality
 *
 * Provides text input, send button, and model selection
 */

import { setIcon, App, Platform, Component } from 'obsidian';
import { initializeSuggesters, SuggesterInstances } from './suggesters/initializeSuggesters';
import { ContentEditableHelper } from '../utils/ContentEditableHelper';
import { ReferenceExtractor, ReferenceMetadata } from '../utils/ReferenceExtractor';
import { MessageEnhancement } from './suggesters/base/SuggesterInterfaces';
import { isMobile, isIOS } from '../../../utils/platform';

export class ChatInput {
  private element: HTMLElement | null = null;
  private inputElement: HTMLElement | null = null;
  private sendButton: HTMLButtonElement | null = null;
  private isLoading = false;
  private hasConversation = false;
  private suggesters: SuggesterInstances | null = null;

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

    // Input wrapper - contains both textarea and embedded send button
    const inputWrapper = this.container.createDiv('chat-input-wrapper');

    // Contenteditable input
    this.inputElement = inputWrapper.createDiv('chat-textarea');
    this.inputElement.contentEditable = 'true';
    this.inputElement.setAttribute('data-placeholder', 'Type your message...');
    this.inputElement.setAttribute('role', 'textbox');
    this.inputElement.setAttribute('aria-multiline', 'true');

    // Handle Enter key (send) and Shift+Enter (new line)
    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        // Don't send if any suggester is active (let suggester handle it)
        const anySuggesterActive =
          this.suggesters?.noteSuggester?.getIsActive() ||
          this.suggesters?.toolSuggester?.getIsActive() ||
          this.suggesters?.agentSuggester?.getIsActive();

        if (!anySuggesterActive) {
          e.preventDefault();
          this.handleSendMessage();
        }
      }
    };

    // Auto-resize on input
    const inputHandler = () => {
      this.autoResizeInput();
    };

    // iOS: Scroll input into view when keyboard opens
    const focusHandler = () => {
      // Wait for keyboard animation to complete
      setTimeout(() => {
        this.inputElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    };

    // Register events with component for auto-cleanup
    this.component!.registerDomEvent(this.inputElement, 'keydown', keydownHandler);
    this.component!.registerDomEvent(this.inputElement, 'input', inputHandler);
    if (isIOS()) {
      this.component!.registerDomEvent(this.inputElement, 'focus', focusHandler);
    }

    // Mobile: Add mobile-specific class for styling
    if (isMobile()) {
      inputWrapper.addClass('chat-input-mobile');
    }

    // Send button - embedded inside the input wrapper (bottom-right)
    // Uses Obsidian's clickable-icon class for proper icon sizing
    this.sendButton = inputWrapper.createEl('button', {
      cls: 'chat-send-button clickable-icon'
    });

    // Add send icon using Obsidian's setIcon
    setIcon(this.sendButton, 'arrow-up');
    this.sendButton.setAttribute('aria-label', 'Send message');

    const sendClickHandler = () => {
      this.handleSendOrStop();
    };
    this.component!.registerDomEvent(this.sendButton, 'click', sendClickHandler);

    // Initialize suggesters if app is available
    if (this.app && this.inputElement) {
      this.suggesters = initializeSuggesters(this.app, this.inputElement);
    }

    this.element = this.container;
    this.updateUI();
  }

  /**
   * Handle send or stop based on current state
   */
  private handleSendOrStop(): void {
    const actuallyLoading = this.isLoading || this.getLoadingState();

    if (actuallyLoading) {
      // Stop generation
      if (this.onStopGeneration) {
        this.onStopGeneration();
      }
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
    this.inputElement.style.height = 'auto';

    // Set height limits - matches CSS min/max heights
    const minHeight = 48;
    const maxHeight = 120;
    const newHeight = Math.min(Math.max(this.inputElement.scrollHeight, minHeight), maxHeight);
    this.inputElement.style.height = newHeight + 'px';

    // Enable scrolling if content exceeds max height
    this.inputElement.style.overflowY = this.inputElement.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  /**
   * Update UI based on current state
   */
  private updateUI(): void {
    if (!this.sendButton || !this.inputElement) return;

    const actuallyLoading = this.isLoading || this.getLoadingState();
    const hasConversation = this.getHasConversation ? this.getHasConversation() : this.hasConversation;

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
    } else if (actuallyLoading) {
      // Show stop button (keep enabled so user can click to stop)
      this.sendButton.disabled = false;
      this.sendButton.classList.add('stop-mode');
      this.sendButton.classList.remove('disabled-mode');
      this.sendButton.empty();
      setIcon(this.sendButton, 'square');
      this.sendButton.setAttribute('aria-label', 'Stop generation');
      this.inputElement.contentEditable = 'false';
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
    }
  }

  /**
   * Get message enhancer (for accessing enhancements before sending)
   */
  getMessageEnhancer() {
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
    if (this.suggesters) {
      this.suggesters.cleanup();
      this.suggesters = null;
    }

    this.element = null;
    this.inputElement = null;
    this.sendButton = null;
  }
}
