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

import { App, Plugin, Platform, Notice } from 'obsidian';
import { EmbeddingEngine } from './EmbeddingEngine';
import { EmbeddingService } from './EmbeddingService';
import { EmbeddingWatcher } from './EmbeddingWatcher';
import { ConversationEmbeddingWatcher } from './ConversationEmbeddingWatcher';
import { IndexingQueue } from './IndexingQueue';
import { EmbeddingStatusBar } from './EmbeddingStatusBar';
import { createRetrievalDreamService, RetrievalDream } from './adapter/createRetrievalDreamService';
import type { MemoryTraceQuery } from './adapter/RetrievalFeedbackSources';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';
import type { MessageRepository } from '../../database/repositories/MessageRepository';

/** Structural view of the plugin's settings needed for adapter persistence + kill-switch. */
interface PluginWithSettings {
  settings?: {
    storage?: unknown;
    embeddings?: { retrievalLearning?: boolean };
  };
}

/** How often a dream-consolidation cycle runs (ms). */
const DREAM_INTERVAL_MS = 45 * 60 * 1000;

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
  private retrievalDream: RetrievalDream | null = null;

  private isEnabled: boolean;
  private isInitialized = false;

  constructor(
    app: App,
    plugin: Plugin,
    db: SQLiteCacheManager,
    enableEmbeddings = true,
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
  initialize(): void {
    if (!this.isEnabled || this.isInitialized) {
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
      if (this.messageRepository) {
        this.conversationWatcher = new ConversationEmbeddingWatcher(
          this.service,
          this.messageRepository,
          this.db
        );
        this.conversationWatcher.start();
      }

      // Start background indexing after a brief delay
      // This ensures the plugin is fully loaded before we start heavy processing
      window.setTimeout(() => {
        void this.runBackgroundIndexing();
      }, 3000); // 3-second delay

      // Wire the self-improving retrieval adapter ("dreaming"). Safe by design:
      // identity until something trains, and the promotion gate prevents
      // regressions, so this never degrades search.
      this.initRetrievalLearning();

      this.isInitialized = true;

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

  /**
   * Set up the self-improving retrieval adapter: load any persisted adapter,
   * schedule periodic dream cycles, and register a manual "dream now" command.
   * Fully guarded — any failure here must never break embeddings.
   */
  private initRetrievalLearning(): void {
    if (!this.service) return;

    try {
      const pluginSettings = (this.plugin as unknown as PluginWithSettings).settings;

      this.retrievalDream = createRetrievalDreamService({
        service: this.service,
        db: this.db as unknown as MemoryTraceQuery,
        fs: this.app.vault.adapter,
        getSettings: () => (pluginSettings as never),
        configDir: this.app.vault.configDir
      });

      // Apply a previously-trained adapter on startup (identity if none).
      void this.retrievalDream.loadAndApply().catch((error) => {
        console.error('[EmbeddingManager] Failed to load retrieval adapter:', error);
      });

      // Periodic consolidation, unless explicitly disabled.
      if (pluginSettings?.embeddings?.retrievalLearning !== false) {
        const interval = window.setInterval(() => {
          void this.runDreamCycle(false);
        }, DREAM_INTERVAL_MS);
        this.plugin.registerInterval(interval);
      }

      this.plugin.addCommand({
        id: 'consolidate-retrieval-memory',
        name: 'Consolidate retrieval memory (dream now)',
        callback: () => { void this.runDreamCycle(true); }
      });
    } catch (error) {
      console.error('[EmbeddingManager] Failed to initialize retrieval learning:', error);
    }
  }

  /**
   * Run a single dream-consolidation cycle. Notifies the user only when an
   * improved adapter is actually promoted (or on explicit manual trigger).
   */
  async runDreamCycle(notify: boolean): Promise<void> {
    if (!this.retrievalDream) return;

    try {
      const report = await this.retrievalDream.dream.runDreamCycle();
      if (report.promoted) {
        new Notice(
          `Nexus consolidated retrieval memory — search relevance improved ` +
          `(${report.minedExamples} examples).`
        );
      } else if (notify) {
        new Notice(
          report.reason === 'insufficient-data'
            ? 'Not enough retrieval history to learn from yet.'
            : 'Retrieval memory consolidated — no improvement to apply.'
        );
      }
    } catch (error) {
      console.error('[EmbeddingManager] Dream cycle failed:', error);
      if (notify) new Notice('Retrieval memory consolidation failed (see console).');
    }
  }

  private async runBackgroundIndexing(): Promise<void> {
    if (!this.queue) {
      return;
    }

    try {
      // Phase 1: Index all notes
      await this.queue.startFullIndex();

      // Phase 2: Backfill existing traces (from migration)
      await this.queue.startTraceIndex();

      // Phase 3: Backfill existing conversations
      // Runs after notes and traces; idempotent and resumable on interrupt
      await this.queue.startConversationIndex();
    } catch (error) {
      console.error('[EmbeddingManager] Background indexing failed:', error);
    }
  }
}
