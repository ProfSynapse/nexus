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
  private currentIconName: string | null = null;
  private isEnabled: boolean;
  private progressHandler: ((progress: IndexingProgress) => void) | null = null;

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

    this.currentIconName = null;

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
    this.controlEl.addClass('nexus-embedding-control-interactive');

    // Wire up progress events (store handler for cleanup)
    this.progressHandler = this.handleProgress.bind(this);
    this.indexingQueue.on('progress', this.progressHandler);

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
        this.setText(
          `Indexing: ${progress.processedNotes}/${progress.totalNotes}`
        );
        this.setControlIcon('pause', () => this.indexingQueue.pause());
        break;

      case 'paused':
        this.show();
        this.setText(
          `Paused: ${progress.processedNotes}/${progress.totalNotes}`
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

    // Optimization: Don't update if icon hasn't changed
    // This prevents DOM thrashing which can break click events
    if (this.currentIconName === iconName) {
      return;
    }
    this.currentIconName = iconName;

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
      this.plugin.registerDomEvent(this.controlEl, 'click', onClick);
    }
  }

  /**
   * Show status bar
   */
  private show(): void {
    if (this.statusBarItem) {
      this.statusBarItem.removeClass('nexus-embedding-status-hidden');
      this.statusBarItem.addClass('nexus-embedding-status-visible');
    }
  }

  /**
   * Hide status bar
   */
  private hide(): void {
    if (this.statusBarItem) {
      this.statusBarItem.removeClass('nexus-embedding-status-visible');
      this.statusBarItem.addClass('nexus-embedding-status-hidden');
    }
  }

  /**
   * Clean up (called on plugin unload)
   */
  destroy(): void {
    // Remove progress listener from IndexingQueue
    if (this.progressHandler) {
      this.indexingQueue.removeListener('progress', this.progressHandler);
      this.progressHandler = null;
    }

    if (this.statusBarItem) {
      this.statusBarItem.remove();
      this.statusBarItem = null;
      this.textEl = null;
      this.controlEl = null;
      this.currentIconName = null;
    }
  }
}
