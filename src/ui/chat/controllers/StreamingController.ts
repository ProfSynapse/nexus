/**
 * StreamingController - Handles all streaming-related UI updates and animations
 * Now with streaming-markdown integration for progressive markdown rendering
 *
 * ARCHITECTURE NOTE:
 * This controller manages ONLY ephemeral UI animation state:
 * - Loading dot animations (activeAnimations)
 * - Streaming-markdown parser state (streamingStates)
 *
 * It does NOT maintain message lifecycle state (draft/streaming/complete/etc).
 * Message lifecycle state is managed by MessageManager and stored in the
 * message objects themselves. This controller is called by ChatView when
 * streaming events occur, and it updates the UI accordingly.
 *
 * State separation:
 * - Message state (draft/streaming/complete) → MessageManager + Storage
 * - UI animation state (dots, parser) → StreamingController (ephemeral)
 */

import { MarkdownRenderer } from '../utils/MarkdownRenderer';
import { App, Component } from 'obsidian';
import type { StreamingState, ElementWithLoadingInterval } from '../types/streaming';

export interface StreamingControllerEvents {
  onAnimationStarted: (messageId: string) => void;
  onAnimationStopped: (messageId: string) => void;
}

export class StreamingController {
  private activeAnimations = new Map<string, NodeJS.Timeout>(); // messageId -> intervalId
  private streamingStates = new Map<string, StreamingState>(); // messageId -> streaming-markdown state

  constructor(
    private containerEl: HTMLElement,
    private app: App,
    private component: Component,
    private events?: StreamingControllerEvents
  ) {}

  /**
   * Show loading animation for AI response
   */
  showAILoadingState(messageId: string): void {
    // Find the message element and add loading animation
    const messageElement = this.containerEl.querySelector(`[data-message-id="${messageId}"]`);
    if (messageElement) {
      const contentElement = messageElement.querySelector('.message-bubble .message-content');
      if (contentElement) {
        contentElement.empty();
        const loadingSpan = contentElement.createEl('span', { cls: 'ai-loading' });
        loadingSpan.appendText('Thinking');
        loadingSpan.createEl('span', { cls: 'dots', text: '...' });
        this.startLoadingAnimation(contentElement);
      }
    }
  }

  /**
   * Start streaming for a message (initialize streaming-markdown parser)
   */
  startStreaming(messageId: string): void {
    const messageElement = this.containerEl.querySelector(`[data-message-id="${messageId}"]`);
    
    if (messageElement) {
      const contentElement = messageElement.querySelector('.message-bubble .message-content');

      if (contentElement) {
        // Stop loading animation
        this.stopLoadingAnimation(contentElement);

        // Initialize streaming-markdown parser for this message
        const streamingState = MarkdownRenderer.initializeStreamingParser(contentElement as HTMLElement);
        this.streamingStates.set(messageId, streamingState);
      }
    }
  }

  /**
   * Update streaming message with new chunk (progressive rendering)
   */
  updateStreamingChunk(messageId: string, chunk: string): void {
    const streamingState = this.streamingStates.get(messageId);

    if (streamingState) {
      MarkdownRenderer.writeStreamingChunk(streamingState, chunk);
    } else {
      // Initialize streaming if we missed the start
      this.startStreaming(messageId);
      // Try again
      const newStreamingState = this.streamingStates.get(messageId);
      if (newStreamingState) {
        MarkdownRenderer.writeStreamingChunk(newStreamingState, chunk);
      }
    }
  }

  /**
   * Finalize streaming for a message (switch to final Obsidian rendering if needed)
   */
  finalizeStreaming(messageId: string, finalContent: string): void {
    const streamingState = this.streamingStates.get(messageId);
    const messageElement = this.containerEl.querySelector(`[data-message-id="${messageId}"]`);
    
    if (streamingState && messageElement) {
      const contentElement = messageElement.querySelector('.message-bubble .message-content');

      if (contentElement) {
        MarkdownRenderer.finalizeStreamingContent(
          streamingState,
          finalContent,
          contentElement as HTMLElement,
          this.app,
          this.component
        ).then(() => {
          // Clean up streaming state
          this.streamingStates.delete(messageId);
        }).catch(error => {
          console.error('[StreamingController] Error finalizing streaming:', error);
          // Clean up anyway
          this.streamingStates.delete(messageId);
        });
      }
    }
  }

  /**
   * Start loading animation (animated dots)
   */
  startLoadingAnimation(element: Element): void {
    const dotsElement = element.querySelector('.dots');
    if (dotsElement) {
      let dotCount = 0;
      const interval = setInterval(() => {
        dotCount = (dotCount + 1) % 4;
        dotsElement.textContent = '.'.repeat(dotCount);
      }, 500);
      
      // Store interval ID for cleanup
      const messageId = this.getMessageIdFromElement(element);
      if (messageId) {
        this.activeAnimations.set(messageId, interval);
        this.events?.onAnimationStarted(messageId);
      }

      // Also store on element for backward compatibility
      (element as ElementWithLoadingInterval)._loadingInterval = interval;
    }
  }

  /**
   * Stop loading animation
   */
  stopLoadingAnimation(element: Element): void {
    // Clean up from element storage (backward compatibility)
    const elementWithInterval = element as ElementWithLoadingInterval;
    const elementInterval = elementWithInterval._loadingInterval;
    if (elementInterval) {
      clearInterval(elementInterval);
      delete elementWithInterval._loadingInterval;
    }

    // Clean up from our tracking
    const messageId = this.getMessageIdFromElement(element);
    if (messageId) {
      const interval = this.activeAnimations.get(messageId);
      if (interval) {
        clearInterval(interval);
        this.activeAnimations.delete(messageId);
        this.events?.onAnimationStopped(messageId);
      }
    }
  }

  /**
   * Stop all active animations
   */
  stopAllAnimations(): void {
    this.activeAnimations.forEach((interval, messageId) => {
      clearInterval(interval);
      this.events?.onAnimationStopped(messageId);
    });
    this.activeAnimations.clear();
  }

  /**
   * Remove loading message from UI
   */
  removeLoadingMessage(messageId: string): void {
    const messageElement = this.containerEl.querySelector(`[data-message-id="${messageId}"]`);
    if (messageElement) {
      // Stop any active animation for this message
      const contentElement = messageElement.querySelector('.message-bubble .message-content');
      if (contentElement) {
        this.stopLoadingAnimation(contentElement);
      }
      
      // Remove the message element
      messageElement.remove();
    }

    // Clean up from our tracking
    const interval = this.activeAnimations.get(messageId);
    if (interval) {
      clearInterval(interval);
      this.activeAnimations.delete(messageId);
    }
  }

  /**
   * Get message ID from an element by traversing up the DOM
   */
  private getMessageIdFromElement(element: Element): string | null {
    let current = element as Element | null;
    while (current) {
      const messageId = current.getAttribute('data-message-id');
      if (messageId) {
        return messageId;
      }
      current = current.parentElement;
    }
    return null;
  }

  /**
   * Escape HTML for safe display
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Get active animation count (for debugging/monitoring)
   */
  getActiveAnimationCount(): number {
    return this.activeAnimations.size;
  }

  /**
   * Cleanup all resources
   */
  cleanup(): void {
    this.stopAllAnimations();
    // Clean up streaming states
    this.streamingStates.clear();
  }
}