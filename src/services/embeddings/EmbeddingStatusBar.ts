/**
 * Location: src/services/embeddings/EmbeddingStatusBar.ts
 * Purpose: Status bar progress display for embedding indexing (desktop only)
 *
 * Features:
 * - Shows progress percentage and ETA
 * - Pause/resume controls
 * - Desktop-only (status bar not available on mobile)
 * - Auto-hides when idle or complete
 *
 * Relationships:
 * - Listens to IndexingQueue progress events
 * - Uses Obsidian Plugin API for status bar
 */

import { Plugin, Notice, Platform, setIcon } from 'obsidian';
import { IndexingQueue, IndexingProgress } from './IndexingQueue';

/**
 * Status bar for embedding progress
 *
 * Desktop-only - status bar is not available on mobile
 */
export class EmbeddingStatusBar {
  private plugin: Plugin;
  private indexingQueue: IndexingQueue;
  private statusBarItem: HTMLElement | null = null;
  private textEl: HTMLSpanElement | null = null;
  private controlEl: HTMLSpanElement | null = null;
  private isEnabled: boolean;

  constructor(
    plugin: Plugin,
    indexingQueue: IndexingQueue
  ) {
    this.plugin = plugin;
    this.indexingQueue = indexingQueue;

    // Disable on mobile (status bar not available)
    this.isEnabled = !Platform.isMobile;
  }

  /**
   * Initialize status bar item
   * Call in plugin onload()
   */
  init(): void {
    if (!this.isEnabled) {
      return;
    }

    // Create status bar item (returns HTMLElement)
    this.statusBarItem = this.plugin.addStatusBarItem();
    this.statusBarItem.addClass('nexus-embedding-status');

    // Text display
    this.textEl = this.statusBarItem.createEl('span', {
      text: '',
      cls: 'nexus-embedding-text'
    });

    // Clickable control (pause/resume)
    this.controlEl = this.statusBarItem.createEl('span', {
      text: '',
      cls: 'nexus-embedding-control'
    });
    this.controlEl.style.cursor = 'pointer';
    this.controlEl.style.marginLeft = '4px';

    // Wire up progress events
    this.indexingQueue.on('progress', this.handleProgress.bind(this));

    // Initially hidden
    this.hide();
  }

  /**
   * Handle progress event from IndexingQueue
   */
  private handleProgress(progress: IndexingProgress): void {
    if (!this.isEnabled) {
      return;
    }

    switch (progress.phase) {
      case 'loading_model':
        this.show();
        this.setText('Loading embedding model...');
        this.setControlIcon('');
        break;

      case 'indexing':
        this.show();
        const pct = progress.totalNotes > 0
          ? Math.round((progress.processedNotes / progress.totalNotes) * 100)
          : 0;

        const eta = progress.estimatedTimeRemaining
          ? this.formatETA(progress.estimatedTimeRemaining)
          : '';

        this.setText(
          `Indexing: ${pct}% (${progress.processedNotes}/${progress.totalNotes}) ${eta}`
        );
        this.setControlIcon('pause', () => this.indexingQueue.pause());
        break;

      case 'paused':
        this.show();
        const pausedPct = progress.totalNotes > 0
          ? Math.round((progress.processedNotes / progress.totalNotes) * 100)
          : 0;

        this.setText(
          `Paused: ${pausedPct}% (${progress.processedNotes}/${progress.totalNotes})`
        );
        this.setControlIcon('play', () => this.indexingQueue.resume());
        break;

      case 'complete':
        if (progress.processedNotes > 0) {
          new Notice(`Embedding complete! ${progress.processedNotes} notes indexed.`);
        }
        this.hide();
        break;

      case 'error':
        new Notice(`Embedding error: ${progress.error}`, 5000);
        this.hide();
        break;

      case 'idle':
        this.hide();
        break;
    }
  }

  /**
   * Format ETA in human-readable form
   */
  private formatETA(seconds: number): string {
    if (seconds < 60) {
      return `~${seconds}s`;
    } else if (seconds < 3600) {
      const minutes = Math.ceil(seconds / 60);
      return `~${minutes}m`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.ceil((seconds % 3600) / 60);
      return `~${hours}h ${minutes}m`;
    }
  }

  /**
   * Set text content
   */
  private setText(text: string): void {
    if (this.textEl) {
      this.textEl.textContent = text;
    }
  }

  /**
   * Set control button with Obsidian icon
   */
  private setControlIcon(iconName: string, onClick?: () => void): void {
    if (!this.controlEl) return;

    // Clear existing content
    this.controlEl.empty();

    // Set icon using Obsidian's setIcon
    if (iconName) {
      setIcon(this.controlEl, iconName);
    }

    // Remove old event listener by cloning the node
    const newControlEl = this.controlEl.cloneNode(true) as HTMLSpanElement;
    this.controlEl.parentNode?.replaceChild(newControlEl, this.controlEl);
    this.controlEl = newControlEl;

    if (onClick) {
      this.controlEl.addEventListener('click', onClick);
    }
  }

  /**
   * Show status bar
   */
  private show(): void {
    if (this.statusBarItem) {
      this.statusBarItem.style.display = 'flex';
    }
  }

  /**
   * Hide status bar
   */
  private hide(): void {
    if (this.statusBarItem) {
      this.statusBarItem.style.display = 'none';
    }
  }

  /**
   * Clean up (called on plugin unload)
   */
  destroy(): void {
    if (this.statusBarItem) {
      this.statusBarItem.remove();
      this.statusBarItem = null;
      this.textEl = null;
      this.controlEl = null;
    }
  }
}
