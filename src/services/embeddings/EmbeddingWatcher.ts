/**
 * Location: src/services/embeddings/EmbeddingWatcher.ts
 * Purpose: Watch vault file events and trigger re-embedding
 *
 * Features:
 * - Watches for create, modify, delete, rename events
 * - 10-second debounce to prevent excessive re-embedding
 * - Only processes .md files
 *
 * Relationships:
 * - Uses EmbeddingService to perform embeddings
 * - Registered with Obsidian vault events
 */

import { App, TFile } from 'obsidian';
import { EmbeddingService } from './EmbeddingService';

/**
 * Vault watcher for embedding updates
 *
 * Debounces file changes to avoid re-embedding on every keystroke.
 * 10 seconds is short enough to not lose changes on unexpected vault close,
 * but long enough to avoid excessive work during active editing.
 */
export class EmbeddingWatcher {
  private app: App;
  private embeddingService: EmbeddingService;
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  // 10-second debounce: prevents re-embedding on every keystroke
  // but short enough to not lose changes if vault closes unexpectedly
  private readonly DEBOUNCE_MS = 10000; // 10 seconds

  constructor(
    app: App,
    embeddingService: EmbeddingService
  ) {
    this.app = app;
    this.embeddingService = embeddingService;
  }

  /**
   * Start watching vault events
   */
  start(): void {
    // File modified
    this.app.vault.on('modify', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        this.scheduleReembedding(file.path);
      }
    });

    // File created
    this.app.vault.on('create', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        this.scheduleReembedding(file.path);
      }
    });

    // File deleted
    this.app.vault.on('delete', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        // Cancel any pending re-embedding
        const existing = this.debounceTimers.get(file.path);
        if (existing) {
          clearTimeout(existing);
          this.debounceTimers.delete(file.path);
        }

        // Remove embedding immediately
        this.embeddingService.removeEmbedding(file.path);
      }
    });

    // File renamed
    this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && file.extension === 'md') {
        // Cancel any pending re-embedding for old path
        const existing = this.debounceTimers.get(oldPath);
        if (existing) {
          clearTimeout(existing);
          this.debounceTimers.delete(oldPath);
        }

        // Update path in metadata
        this.embeddingService.updatePath(oldPath, file.path);
      }
    });
  }

  /**
   * Stop watching vault events
   */
  stop(): void {
    // Clear all pending timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Schedule re-embedding with debounce
   *
   * @param notePath - Path to the note
   */
  private scheduleReembedding(notePath: string): void {
    // Clear existing timer if any
    const existing = this.debounceTimers.get(notePath);
    if (existing) {
      clearTimeout(existing);
    }

    // Schedule new timer
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(notePath);

      try {
        await this.embeddingService.embedNote(notePath);
      } catch (error) {
        console.error(`[EmbeddingWatcher] Failed to re-embed ${notePath}:`, error);
      }
    }, this.DEBOUNCE_MS);

    this.debounceTimers.set(notePath, timer);
  }

  /**
   * Force immediate re-embedding of a note (bypasses debounce)
   *
   * @param notePath - Path to the note
   */
  async forceReembed(notePath: string): Promise<void> {
    // Cancel any pending timer
    const existing = this.debounceTimers.get(notePath);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(notePath);
    }

    // Embed immediately
    await this.embeddingService.embedNote(notePath);
  }

  /**
   * Get number of pending re-embeddings
   */
  getPendingCount(): number {
    return this.debounceTimers.size;
  }
}
