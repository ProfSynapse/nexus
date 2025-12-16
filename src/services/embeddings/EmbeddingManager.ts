/**
 * Location: src/services/embeddings/EmbeddingManager.ts
 * Purpose: High-level manager for embedding system initialization and coordination
 *
 * Features:
 * - Desktop-only (disabled on mobile)
 * - Lazy initialization (3-second delay on startup)
 * - Coordinates EmbeddingEngine, EmbeddingService, EmbeddingWatcher, IndexingQueue, and StatusBar
 * - Graceful shutdown with cleanup
 *
 * Relationships:
 * - Called by PluginLifecycleManager for initialization
 * - Manages all embedding system components
 */

import { App, Plugin, Platform } from 'obsidian';
import { EmbeddingEngine } from './EmbeddingEngine';
import { EmbeddingService } from './EmbeddingService';
import { EmbeddingWatcher } from './EmbeddingWatcher';
import { IndexingQueue } from './IndexingQueue';
import { EmbeddingStatusBar } from './EmbeddingStatusBar';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';

/**
 * Embedding system manager
 *
 * Desktop-only - automatically disabled on mobile platforms
 */
export class EmbeddingManager {
  private app: App;
  private plugin: Plugin;
  private db: SQLiteCacheManager;

  private engine: EmbeddingEngine | null = null;
  private service: EmbeddingService | null = null;
  private watcher: EmbeddingWatcher | null = null;
  private queue: IndexingQueue | null = null;
  private statusBar: EmbeddingStatusBar | null = null;

  private isEnabled: boolean;
  private isInitialized: boolean = false;

  constructor(
    app: App,
    plugin: Plugin,
    db: SQLiteCacheManager
  ) {
    this.app = app;
    this.plugin = plugin;
    this.db = db;

    // Disable on mobile entirely
    this.isEnabled = !Platform.isMobile;

    if (!this.isEnabled) {
      console.log('[EmbeddingManager] Disabled on mobile platform');
    }
  }

  /**
   * Initialize the embedding system
   * Should be called after a delay from plugin startup (e.g., 3 seconds)
   */
  async initialize(): Promise<void> {
    if (!this.isEnabled) {
      console.log('[EmbeddingManager] Skipping initialization on mobile');
      return;
    }

    if (this.isInitialized) {
      console.warn('[EmbeddingManager] Already initialized');
      return;
    }

    try {
      const startTime = performance.now();
      console.log('[EmbeddingManager] ========================================');
      console.log('[EmbeddingManager] Initializing embedding system...');
      console.log('[EmbeddingManager] Platform:', Platform.isMobile ? 'Mobile' : 'Desktop');

      // Check database status
      console.log('[EmbeddingManager] Database ready:', this.db.isReady());
      console.log('[EmbeddingManager] Database path:', this.db.getDbPath());

      // Create components
      console.log('[EmbeddingManager] Creating EmbeddingEngine...');
      this.engine = new EmbeddingEngine();
      const modelInfo = this.engine.getModelInfo();
      console.log(`[EmbeddingManager] Model: ${modelInfo.id} (${modelInfo.dimensions}d)`);

      console.log('[EmbeddingManager] Creating EmbeddingService...');
      this.service = new EmbeddingService(this.app, this.db, this.engine);

      console.log('[EmbeddingManager] Creating EmbeddingWatcher (10s debounce)...');
      this.watcher = new EmbeddingWatcher(this.app, this.service);

      console.log('[EmbeddingManager] Creating IndexingQueue...');
      this.queue = new IndexingQueue(this.app, this.service, this.db);

      console.log('[EmbeddingManager] Creating EmbeddingStatusBar...');
      this.statusBar = new EmbeddingStatusBar(this.plugin, this.queue);

      // Initialize status bar (desktop only)
      this.statusBar.init();
      console.log('[EmbeddingManager] Status bar initialized');

      // Start watching vault events
      this.watcher.start();
      console.log('[EmbeddingManager] Vault watcher started');

      const initTime = (performance.now() - startTime).toFixed(0);
      console.log(`[EmbeddingManager] Component setup complete (${initTime}ms)`);

      // Start background indexing after a brief delay
      // This ensures the plugin is fully loaded before we start heavy processing
      setTimeout(async () => {
        if (this.queue) {
          const noteCount = this.app.vault.getMarkdownFiles().length;
          console.log('[EmbeddingManager] ----------------------------------------');
          console.log(`[EmbeddingManager] Starting background indexing (${noteCount} notes in vault)...`);
          console.log('[EmbeddingManager] Transformers.js will load from CDN on first embed');

          // Phase 1: Index all notes
          await this.queue.startFullIndex();

          // Phase 2: Backfill existing traces (from migration)
          console.log('[EmbeddingManager] ----------------------------------------');
          console.log('[EmbeddingManager] Starting trace backfill...');
          await this.queue.startTraceIndex();
        }
      }, 3000); // 3-second delay

      this.isInitialized = true;
      console.log('[EmbeddingManager] Embedding system ready');
      console.log('[EmbeddingManager] ========================================');

    } catch (error) {
      console.error('[EmbeddingManager] Initialization failed:', error);
      // Don't throw - embeddings are optional functionality
    }
  }

  /**
   * Shutdown the embedding system
   * Called during plugin unload
   */
  async shutdown(): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    console.log('[EmbeddingManager] Shutting down embedding system...');

    try {
      // Cancel any ongoing indexing
      if (this.queue) {
        this.queue.cancel();
      }

      // Stop watching vault events
      if (this.watcher) {
        this.watcher.stop();
      }

      // Clean up status bar
      if (this.statusBar) {
        this.statusBar.destroy();
      }

      // Dispose of embedding engine
      if (this.engine) {
        await this.engine.dispose();
      }

      this.isInitialized = false;
      console.log('[EmbeddingManager] Embedding system shut down successfully');

    } catch (error) {
      console.error('[EmbeddingManager] Shutdown failed:', error);
    }
  }

  /**
   * Get the embedding service (for external use)
   */
  getService(): EmbeddingService | null {
    return this.service;
  }

  /**
   * Get the indexing queue (for external use)
   */
  getQueue(): IndexingQueue | null {
    return this.queue;
  }

  /**
   * Check if embedding system is enabled
   */
  isEmbeddingEnabled(): boolean {
    return this.isEnabled && this.isInitialized;
  }

  /**
   * Get statistics about the embedding system
   */
  async getStats(): Promise<{
    enabled: boolean;
    initialized: boolean;
    noteCount: number;
    traceCount: number;
    indexingInProgress: boolean;
  }> {
    if (!this.isEnabled || !this.service) {
      return {
        enabled: false,
        initialized: false,
        noteCount: 0,
        traceCount: 0,
        indexingInProgress: false
      };
    }

    const stats = await this.service.getStats();

    return {
      enabled: this.isEnabled,
      initialized: this.isInitialized,
      noteCount: stats.noteCount,
      traceCount: stats.traceCount,
      indexingInProgress: this.queue?.isIndexing() ?? false
    };
  }
}
