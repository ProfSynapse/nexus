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
 *
 * TEXT RUNS:
 * A turn's visible text is not one blob. When the model thinks, writes, thinks
 * again and writes again, the bubble renders a thinking block above each stretch
 * of text it preceded. So `.message-content` holds an ordered mix of
 * `.message-reasoning` blocks and `.message-turn-text` runs, and the parser is
 * bound to the run currently being written — never to `.message-content` itself,
 * which would wipe the thinking blocks on every parser init.
 */

import { MarkdownRenderer } from '../utils/MarkdownRenderer';
import { App, Component } from 'obsidian';
import type { StreamingState, ElementWithLoadingInterval } from '../types/streaming';

export interface StreamingControllerEvents {
  onAnimationStarted: (messageId: string) => void;
  onAnimationStopped: (messageId: string) => void;
}

export class StreamingController {
  private activeAnimations = new Map<string, number>(); // messageId -> intervalId
  private streamingStates = new Map<string, StreamingState>(); // messageId -> streaming-markdown state
  private activeRuns = new Map<string, HTMLElement>(); // messageId -> the .message-turn-text being written
  private runText = new Map<string, string>(); // messageId -> text written into that run so far

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
    const contentElement = this.resolveContentElement(messageId);
    if (!contentElement) {
      return;
    }

    contentElement.empty();
    const loadingSpan = contentElement.createSpan({ cls: 'ai-loading' });
    loadingSpan.appendText('Thinking');
    loadingSpan.createSpan({ cls: 'dots', text: '...' });
    this.startLoadingAnimation(contentElement);
  }

  /**
   * Start streaming for a message (initialize streaming-markdown parser)
   */
  startStreaming(messageId: string): void {
    const contentElement = this.resolveContentElement(messageId);
    if (!contentElement) {
      return;
    }

    // Stop loading animation
    this.stopLoadingAnimation(contentElement);

    // Bind the parser to a text run, not to .message-content: initializing the
    // parser empties its container, and .message-content also holds the turn's
    // thinking blocks.
    const run = this.openTextRun(contentElement);
    const streamingState = MarkdownRenderer.initializeStreamingParser(run ?? contentElement);
    this.streamingStates.set(messageId, streamingState);
    this.runText.set(messageId, '');
    if (run) {
      this.activeRuns.set(messageId, run);
    } else {
      this.activeRuns.delete(messageId);
    }
  }

  /**
   * Seal the run being written so the next chunk starts a fresh one below the
   * thinking block that just opened. Called when a new reasoning segment begins
   * mid-turn; a no-op when nothing is streaming.
   */
  beginNewTextRun(messageId: string): void {
    const streamingState = this.streamingStates.get(messageId);
    if (!streamingState) {
      return;
    }

    MarkdownRenderer.endStreamingParser(streamingState);
    this.streamingStates.delete(messageId);
    this.activeRuns.delete(messageId);
    this.runText.delete(messageId);
  }

  /**
   * Update streaming message with new chunk (progressive rendering)
   */
  updateStreamingChunk(messageId: string, chunk: string): void {
    const streamingState = this.streamingStates.get(messageId);

    if (streamingState && this.activeRunIsAttached(messageId)) {
      MarkdownRenderer.writeStreamingChunk(streamingState, chunk);
      this.runText.set(messageId, (this.runText.get(messageId) ?? '') + chunk);
      return;
    }

    // Initialize streaming if we missed the start (first chunk of the turn, or
    // the first chunk after a thinking block sealed the previous run)
    this.startStreaming(messageId);
    const newStreamingState = this.streamingStates.get(messageId);
    if (newStreamingState) {
      MarkdownRenderer.writeStreamingChunk(newStreamingState, chunk);
      this.runText.set(messageId, (this.runText.get(messageId) ?? '') + chunk);
    }
  }

  /**
   * Finalize streaming for a message (switch to final Obsidian rendering if needed)
   */
  finalizeStreaming(messageId: string, finalContent: string): void {
    const streamingState = this.streamingStates.get(messageId);
    // Drop the entry synchronously and unconditionally: getCurrentMessageId()
    // reports the last key of this map, and a finalized turn must never stay
    // "current". The old cleanup only ran after an async render AND only when
    // the message element was still in the DOM — a mid-stream conversation
    // switch or reconcile leaked the key forever, after which
    // ToolStatusBarController silently dropped every later turn's
    // present-tense tool status as a messageId mismatch.
    this.streamingStates.delete(messageId);
    const activeRun = this.activeRuns.get(messageId);
    // A turn split across thinking blocks finalizes only the run it was writing,
    // so the earlier runs and the blocks between them survive.
    const runContent = this.runText.get(messageId) ?? finalContent;
    this.activeRuns.delete(messageId);
    this.runText.delete(messageId);

    const messageElement = this.containerEl.querySelector(`[data-message-id="${messageId}"]`);

    if (streamingState && messageElement) {
      const container = activeRun
        ?? messageElement.querySelector<HTMLElement>('.message-bubble .message-content');

      if (container) {
        MarkdownRenderer.finalizeStreamingContent(
          streamingState,
          runContent,
          container,
          this.app,
          this.component
        ).catch(error => {
          console.error('[StreamingController] Error finalizing streaming:', error);
        });
      }
    }
  }

  /**
   * Whether the run this message is streaming into is still in the document.
   *
   * The parser state is keyed by message id and outlives a conversation switch,
   * which rebuilds the transcript from scratch. Writing on into the old detached
   * run silently swallows the rest of the turn, so a detached run is treated as
   * no state at all and the next chunk opens a fresh run in the rebuilt bubble.
   */
  private activeRunIsAttached(messageId: string): boolean {
    const run = this.activeRuns.get(messageId);
    if (!run) {
      // No run recorded (e.g. a harness element that could not host one):
      // nothing to invalidate, keep the existing behaviour.
      return true;
    }
    return run.isConnected !== false;
  }

  /**
   * Resolve a message's `.message-content` container, or null when the bubble
   * has left the DOM (conversation switch, reconcile mid-stream).
   */
  private resolveContentElement(messageId: string): HTMLElement | null {
    const messageElement = this.containerEl.querySelector(`[data-message-id="${messageId}"]`);
    const contentElement = messageElement?.querySelector('.message-bubble .message-content');
    return (contentElement as HTMLElement | null) ?? null;
  }

  /**
   * Return the text run to write into: the trailing empty run when one is
   * already waiting, otherwise a fresh run appended after everything the turn
   * has rendered so far (thinking blocks included) but above the working ticker.
   */
  private openTextRun(contentElement: HTMLElement): HTMLElement | null {
    if (typeof contentElement.createDiv !== 'function') {
      // Defensive: harnesses and popout windows can hand back a bare element
      return null;
    }

    const existing = this.findTrailingEmptyRun(contentElement);
    if (existing) {
      return existing;
    }

    const run = createDiv();
    run.className = 'message-turn-text';

    const ticker = contentElement.querySelector(':scope > .ai-loading-continuation');
    if (ticker) {
      contentElement.insertBefore(run, ticker);
    } else {
      contentElement.appendChild(run);
    }

    return run;
  }

  private findTrailingEmptyRun(contentElement: HTMLElement): HTMLElement | null {
    const children = Array.from(contentElement.children ?? []);
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index] as HTMLElement;
      if (child.classList?.contains('ai-loading-continuation')) {
        continue;
      }
      if (child.classList?.contains('message-turn-text') && !child.textContent?.trim()) {
        return child;
      }
      return null;
    }
    return null;
  }

  /**
   * Start loading animation (animated dots)
   */
  startLoadingAnimation(element: Element): void {
    const dotsElement = element.querySelector('.dots');
    if (dotsElement) {
      let dotCount = 0;
      const interval = window.setInterval(() => {
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
      window.clearInterval(elementInterval);
      delete elementWithInterval._loadingInterval;
    }

    // Clean up from our tracking
    const messageId = this.getMessageIdFromElement(element);
    if (messageId) {
      const interval = this.activeAnimations.get(messageId);
      if (interval) {
        window.clearInterval(interval);
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
      window.clearInterval(interval);
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
      window.clearInterval(interval);
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
   * Get active animation count (for debugging/monitoring)
   */
  getActiveAnimationCount(): number {
    return this.activeAnimations.size;
  }

  /**
   * Get the message ID of the currently streaming message.
   * Returns the most recently started streaming message.
   */
  getCurrentMessageId(): string | null {
    // Array.from(map.keys()) returns keys in insertion order. The last one is the most recent.
    const keys = Array.from(this.streamingStates.keys());
    return keys.length > 0 ? keys[keys.length - 1] : null;
  }

  /**
   * Cleanup all resources
   */
  cleanup(): void {
    this.stopAllAnimations();
    // Clean up streaming states
    this.streamingStates.clear();
    this.activeRuns.clear();
    this.runText.clear();
  }
}