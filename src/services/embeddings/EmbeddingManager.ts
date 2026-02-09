/**
 * Location: src/services/embeddings/EmbeddingManager.ts
 * Purpose: High-level manager for embedding system initialization and coordination
 *
 * Features:
 * - Desktop-only (disabled on mobile)
 * - Lazy initialization (3-second delay on startup)
 * - Coordinates EmbeddingEngine, EmbeddingService, EmbeddingWatcher,
 *   ConversationEmbeddingWatcher, IndexingQueue, and StatusBar
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
import { ConversationEmbeddingWatcher } from './ConversationEmbeddingWatcher';
import { IndexingQueue } from './IndexingQueue';
import { EmbeddingStatusBar } from './EmbeddingStatusBar';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';
import type { MessageRepository } from '../../database/repositories/MessageRepository';

/**
 * Embedding system manager
 *
 * Desktop-only - automatically disabled on mobile platforms
 */
export class EmbeddingManager {
  private app: App;
  private plugin: Plugin;
  private db: SQLiteCacheManager;
  private messageRepository: MessageRepository | null;

  private engine: EmbeddingEngine | null = null;
  private service: EmbeddingService | null = null;
  private watcher: EmbeddingWatcher | null = null;
  private conversationWatcher: ConversationEmbeddingWatcher | null = null;
  private queue: IndexingQueue | null = null;
  private statusBar: EmbeddingStatusBar | null = null;

  private isEnabled: boolean;
  private isInitialized: boolean = false;

  constructor(
    app: App,
    plugin: Plugin,
    db: SQLiteCacheManager,
    enableEmbeddings: boolean = true,
    messageRepository?: MessageRepository
  ) {
    this.app = app;
    this.plugin = plugin;
    this.db = db;
    this.messageRepository = messageRepository ?? null;

    // Disable on mobile or if user disabled embeddings
    this.isEnabled = !Platform.isMobile && enableEmbeddings;
  }

  /**
   * Initialize the embedding system
   * Should be called after a delay from plugin startup (e.g., 3 seconds)
   */
  async initialize(): Promise<void> {
    console.log('[DEBUG] EmbeddingManager.initialize() entered: isEnabled =', this.isEnabled, ', isInitialized =', this.isInitialized);
    if (!this.isEnabled || this.isInitialized) {
      console.log('[DEBUG] EmbeddingManager.initialize() early return: isEnabled =', this.isEnabled, ', isInitialized =', this.isInitialized);
      return;
    }

    try {
      // Create components
      this.engine = new EmbeddingEngine();
      this.service = new EmbeddingService(this.app, this.db, this.engine);
      this.watcher = new EmbeddingWatcher(this.app, this.service);
      this.queue = new IndexingQueue(this.app, this.service, this.db);
      this.statusBar = new EmbeddingStatusBar(this.plugin, this.queue);

      // Initialize status bar (desktop only)
      this.statusBar.init();

      // Start watching vault events (note changes)
      this.watcher.start();

      // Start watching conversation events (assistant message completions)
      console.log('[DEBUG] EmbeddingManager.initialize(): messageRepository truthy =', !!this.messageRepository);
      if (this.messageRepository) {
        this.conversationWatcher = new ConversationEmbeddingWatcher(
          this.service,
          this.messageRepository,
          this.db
        );
        this.conversationWatcher.start();
        console.log('[DEBUG] EmbeddingManager.initialize(): ConversationEmbeddingWatcher started');
      } else {
        console.log('[DEBUG] EmbeddingManager.initialize(): Skipping ConversationEmbeddingWatcher (no messageRepository)');
      }

      // Start background indexing after a brief delay
      // This ensures the plugin is fully loaded before we start heavy processing
      console.log('[DEBUG] EmbeddingManager.initialize(): Scheduling background indexing setTimeout(3000)');
      setTimeout(async () => {
        console.log('[DEBUG] EmbeddingManager background indexing setTimeout fired. queue truthy =', !!this.queue);
        if (this.queue) {
          try {
            // Phase 1: Index all notes
            console.log('[DEBUG] Starting note index...');
            await this.queue.startFullIndex();
            console.log('[DEBUG] Note index complete. Starting trace index...');

            // Phase 2: Backfill existing traces (from migration)
            await this.queue.startTraceIndex();
            console.log('[DEBUG] Trace index complete. Starting conversation index...');

            // Phase 3: Backfill existing conversations
            // Runs after notes and traces; idempotent and resumable on interrupt
            await this.queue.startConversationIndex();
            console.log('[DEBUG] Conversation index complete.');
          } catch (error) {
            console.error('[EmbeddingManager] Background indexing failed:', error);
            console.log('[DEBUG] EmbeddingManager background indexing error:', error);
          }
        }
      }, 3000); // 3-second delay

      this.isInitialized = true;
      console.log('[DEBUG] EmbeddingManager.initialize() completed successfully');

    } catch (error) {
      console.error('[EmbeddingManager] Initialization failed:', error);
      console.log('[DEBUG] EmbeddingManager.initialize() caught error:', error);
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

    try {
      // Cancel indexing and remove all listeners
      if (this.queue) {
        this.queue.destroy();
      }

      // Stop watching vault events
      if (this.watcher) {
        this.watcher.stop();
      }

      // Stop watching conversation events
      if (this.conversationWatcher) {
        this.conversationWatcher.stop();
      }

      // Clean up status bar (removes progress listener)
      if (this.statusBar) {
        this.statusBar.destroy();
      }

      // Dispose of embedding engine (revokes blob URL, removes iframe)
      if (this.engine) {
        await this.engine.dispose();
      }

      this.isInitialized = false;

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
    conversationChunkCount: number;
    indexingInProgress: boolean;
  }> {
    if (!this.isEnabled || !this.service) {
      return {
        enabled: false,
        initialized: false,
        noteCount: 0,
        traceCount: 0,
        conversationChunkCount: 0,
        indexingInProgress: false
      };
    }

    const stats = await this.service.getStats();

    return {
      enabled: this.isEnabled,
      initialized: this.isInitialized,
      noteCount: stats.noteCount,
      traceCount: stats.traceCount,
      conversationChunkCount: stats.conversationChunkCount,
      indexingInProgress: this.queue?.isIndexing() ?? false
    };
  }
}
