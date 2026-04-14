/**
 * NexusLoadingController - Handles Nexus/WebLLM loading overlay logic
 * Location: /src/ui/chat/controllers/NexusLoadingController.ts
 *
 * Manages the loading overlay for Nexus model loading and database initialization.
 * Extracted from ChatView.ts to follow Single Responsibility Principle.
 */

import { Component } from 'obsidian';

/**
 * Controller for Nexus/WebLLM and database loading overlays
 */
export class NexusLoadingController extends Component {
  private overlayEl: HTMLElement | null = null;

  constructor(private containerEl: HTMLElement) {
    super();
    this.findOverlayElement();
  }

  /**
   * Find the loading overlay element in the container
   */
  private findOverlayElement(): void {
    // The overlay is created with class 'nexus-loading-overlay' in ChatLayoutBuilder
    this.overlayEl = this.containerEl.querySelector('.nexus-loading-overlay') as HTMLElement;
  }

  /**
   * Show the Nexus model loading overlay
   */
  showNexusLoadingOverlay(): void {
    if (!this.overlayEl) return;

    // Remove hidden class first (it has display:none !important which overrides visible)
    this.overlayEl.removeClass('chat-loading-overlay-hidden');
    this.overlayEl.addClass('chat-loading-overlay-visible');
    // Trigger reflow for animation
    void this.overlayEl.offsetHeight;
    this.overlayEl.addClass('is-visible');
  }

  /**
   * Update Nexus loading progress
   */
  updateNexusLoadingProgress(progress: number, stage: string): void {
    if (!this.overlayEl) return;

    const statusEl = this.overlayEl.querySelector('[data-status-el]');
    const progressBar = this.overlayEl.querySelector('[data-progress-el]') as HTMLElement;
    const progressText = this.overlayEl.querySelector('[data-progress-text-el]');

    const percent = Math.round(progress * 100);

    if (statusEl) {
      statusEl.textContent = stage || 'Loading model...';
    }

    if (progressBar) {
      progressBar.style.setProperty('width', `${percent}%`);
    }

    if (progressText) {
      progressText.textContent = `${percent}%`;
    }
  }

  /**
   * Hide the Nexus model loading overlay
   */
  hideNexusLoadingOverlay(): void {
    if (!this.overlayEl) return;

    this.overlayEl.removeClass('is-visible');

    // Wait for transition then hide
    setTimeout(() => {
      const overlayEl = this.overlayEl;
      if (!overlayEl) return;

      overlayEl.removeClass('chat-loading-overlay-visible');
      overlayEl.addClass('chat-loading-overlay-hidden');

      // Reset progress
      const progressBar = overlayEl.querySelector('[data-progress-el]') as HTMLElement;
      const progressText = overlayEl.querySelector('[data-progress-text-el]');
      const statusEl = overlayEl.querySelector('[data-status-el]');

      if (progressBar) progressBar.addClass('chat-progress-bar-reset');
      if (progressText) progressText.textContent = '0%';
      if (statusEl) statusEl.textContent = 'Loading model...';
    }, 300);
  }

  /**
   * Show database loading overlay
   */
  showDatabaseLoadingOverlay(): void {
    if (!this.overlayEl) return;

    // Update text for database loading
    const statusEl = this.overlayEl.querySelector('[data-status-el]');
    if (statusEl) statusEl.textContent = 'Loading database...';

    // Remove hidden class first (it has display:none !important which overrides visible)
    this.overlayEl.removeClass('chat-loading-overlay-hidden');
    this.overlayEl.addClass('chat-loading-overlay-visible');
    void this.overlayEl.offsetHeight; // Trigger reflow
    this.overlayEl.addClass('is-visible');
  }

  updateDatabaseLoadingProgress(progress: number, stage: string): void {
    if (!this.overlayEl) return;

    const statusEl = this.overlayEl.querySelector('[data-status-el]');
    const progressBar = this.overlayEl.querySelector('[data-progress-el]') as HTMLElement;
    const progressText = this.overlayEl.querySelector('[data-progress-text-el]');

    const percent = Math.round(Math.max(0, Math.min(progress, 1)) * 100);

    if (statusEl) {
      statusEl.textContent = stage || 'Loading database...';
    }

    if (progressBar) {
      progressBar.style.setProperty('width', `${percent}%`);
      progressBar.removeClass('chat-progress-bar-reset');
    }

    if (progressText) {
      progressText.textContent = `${percent}%`;
    }
  }

  /**
   * Hide database loading overlay
   */
  hideDatabaseLoadingOverlay(): void {
    if (!this.overlayEl) return;

    this.overlayEl.removeClass('is-visible');
    setTimeout(() => {
      const overlayEl = this.overlayEl;
      if (!overlayEl) return;

      overlayEl.removeClass('chat-loading-overlay-visible');
      overlayEl.addClass('chat-loading-overlay-hidden');
      // Reset text for potential Nexus loading later
      const statusEl = overlayEl.querySelector('[data-status-el]');
      if (statusEl) statusEl.textContent = 'Loading model...';
    }, 300);
  }

  /**
   * Wait for database to be ready, showing loading overlay if needed
   *
   * @param storageAdapter Storage adapter with isReady() and waitForReady() methods
   */
  async waitForDatabaseReady(storageAdapter: {
    isReady?: () => boolean;
    waitForReady?: () => Promise<boolean>;
  }): Promise<void> {
    if (!storageAdapter) return;

    try {
      // If already ready, no need to show overlay
      if (storageAdapter.isReady?.()) {
        return;
      }

      // Show loading overlay while waiting
      this.showDatabaseLoadingOverlay();

      // Wait for database to be ready
      await storageAdapter.waitForReady?.();

      // Hide overlay
      this.hideDatabaseLoadingOverlay();
    } catch {
      this.hideDatabaseLoadingOverlay();
    }
  }

  /**
   * Clean up resources
   */
  onunload(): void {
    this.overlayEl = null;
  }
}
