/**
 * MessageBranchNavigator - UI component for navigating between message alternatives
 * 
 * Shows mini "< X/Y >" navigation for individual messages that have multiple alternatives
 * Only displays when message has alternatives
 */

import { ConversationMessage } from '../../../types/chat/ChatTypes';
import { setIcon, Component } from 'obsidian';

export interface MessageBranchNavigatorEvents {
  onAlternativeChanged: (messageId: string, alternativeIndex: number) => void;
  onError: (message: string) => void;
}

export class MessageBranchNavigator {
  private container: HTMLElement;
  private branchIndicator!: HTMLElement;
  private prevButton!: HTMLButtonElement;
  private nextButton!: HTMLButtonElement;
  private currentMessage: ConversationMessage | null = null;

  constructor(
    container: HTMLElement,
    private events: MessageBranchNavigatorEvents,
    private component?: Component
  ) {
    this.container = container;
    this.createBranchNavigator();
    this.hide(); // Hidden by default
  }

  /**
   * Create the mini branch navigation UI
   */
  private createBranchNavigator(): void {
    this.container.addClass('message-branch-navigator');

    this.prevButton = this.container.createEl('button', {
      cls: 'message-action-btn message-branch-prev clickable-icon',
      attr: {
        'aria-label': 'Previous alternative',
        'title': 'Go to previous alternative response'
      }
    });
    setIcon(this.prevButton, 'chevron-left');

    // Branch indicator (shows current/total like "2/4")
    this.branchIndicator = this.container.createDiv('message-branch-indicator');
    this.branchIndicator.textContent = '1/1';

    this.nextButton = this.container.createEl('button', {
      cls: 'message-action-btn message-branch-next clickable-icon',
      attr: {
        'aria-label': 'Next alternative',
        'title': 'Go to next alternative response'
      }
    });
    setIcon(this.nextButton, 'chevron-right');

    // Event listeners
    const prevHandler = () => this.handlePreviousAlternative();
    const nextHandler = () => this.handleNextAlternative();
    this.component!.registerDomEvent(this.prevButton, 'click', prevHandler);
    this.component!.registerDomEvent(this.nextButton, 'click', nextHandler);
  }

  /**
   * Update the navigator for a message
   */
  updateMessage(message: ConversationMessage): void {
    this.currentMessage = message;
    this.updateDisplay();
  }

  /**
   * Update the display based on current message
   */
  private updateDisplay(): void {
    if (!this.currentMessage || !this.hasAlternatives()) {
      this.hide();
      return;
    }

    const alternativeCount = this.getAlternativeCount();
    const currentIndex = this.currentMessage.activeAlternativeIndex || 0;
    
    // Show and update the indicator (1-based display)
    this.show();
    this.branchIndicator.textContent = `${currentIndex + 1}/${alternativeCount}`;
    
    // Update button states
    this.updateButtonStates(currentIndex, alternativeCount);
  }

  /**
   * Update navigation button states
   */
  private updateButtonStates(currentIndex: number, totalCount: number): void {
    const isFirst = currentIndex === 0;
    const isLast = currentIndex === totalCount - 1;
    
    this.prevButton.disabled = isFirst;
    this.nextButton.disabled = isLast;
    
    // Update visual states
    this.prevButton.toggleClass('disabled', isFirst);
    this.nextButton.toggleClass('disabled', isLast);
  }

  /**
   * Handle previous alternative navigation
   */
  private async handlePreviousAlternative(): Promise<void> {
    if (!this.currentMessage) return;
    
    const currentIndex = this.currentMessage.activeAlternativeIndex || 0;
    if (currentIndex <= 0) return;

    const newIndex = currentIndex - 1;
    this.events.onAlternativeChanged(this.currentMessage.id, newIndex);
    this.updateDisplay();
  }

  /**
   * Handle next alternative navigation
   */
  private async handleNextAlternative(): Promise<void> {
    if (!this.currentMessage) return;
    
    const currentIndex = this.currentMessage.activeAlternativeIndex || 0;
    const totalCount = this.getAlternativeCount();
    if (currentIndex >= totalCount - 1) return;

    const newIndex = currentIndex + 1;
    this.events.onAlternativeChanged(this.currentMessage.id, newIndex);
    this.updateDisplay();
  }

  /**
   * Check if current message has alternatives
   */
  private hasAlternatives(): boolean {
    return !!(this.currentMessage?.alternatives && this.currentMessage.alternatives.length > 0);
  }

  /**
   * Get total alternative count (including the original message)
   */
  private getAlternativeCount(): number {
    if (!this.hasAlternatives()) return 1;
    return (this.currentMessage!.alternatives!.length) + 1; // +1 for original message
  }

  /**
   * Show the navigator
   */
  private show(): void {
    this.container.removeClass('message-branch-navigator-hidden');
    this.container.addClass('message-branch-navigator-visible');
  }

  /**
   * Hide the navigator
   */
  private hide(): void {
    this.container.removeClass('message-branch-navigator-visible');
    this.container.addClass('message-branch-navigator-hidden');
  }

  /**
   * Get current alternative information for external use
   */
  getCurrentAlternativeInfo(): { current: number; total: number; hasAlternatives: boolean } | null {
    if (!this.currentMessage) return null;
    
    const currentIndex = this.currentMessage.activeAlternativeIndex || 0;
    const totalCount = this.getAlternativeCount();
    
    return {
      current: currentIndex + 1, // 1-based for display
      total: totalCount,
      hasAlternatives: this.hasAlternatives()
    };
  }

  /**
   * Check if navigator is currently visible
   */
  isVisible(): boolean {
    return this.container.hasClass('message-branch-navigator-visible');
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.prevButton.removeEventListener('click', () => this.handlePreviousAlternative());
    this.nextButton.removeEventListener('click', () => this.handleNextAlternative());
    this.container.empty();
  }
}