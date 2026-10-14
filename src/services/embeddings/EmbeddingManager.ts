/**
 * Location: src/services/embeddings/EmbeddingManager.ts
 * Purpose: High-level manager for embedding system initialization and coordination
 *
 * Features:
 * - Desktop-only (disabled on mobile)
 * - Lazy initialization (3-second delay on startup)
 * - Coordinates EmbeddingEngine, EmbeddingService, EmbeddingWatcher,
 *   ConversationEmbeddingWatcher, IndexingQueue, and StatusBar
 * - Can be turned off and on at runtime (setEnabled) without a restart
 * - Publishes its status and indexing progress (onStateChange, getStatus)
 * - Deletes the stored vectors on request while turned off (deleteIndex)
 * - Graceful shutdown with cleanup
 *
 * Relationships:
 * - Called by PluginLifecycleManager for initialization and hot-apply
 * - Manages all embedding system components
 */

import { App, Plugin, Platform, Notice, Events, type EventRef } from 'obsidian';
import { EmbeddingEngine } from './EmbeddingEngine';
import { EmbeddingService } from './EmbeddingService';
import { EmbeddingWatcher } from './EmbeddingWatcher';
import { ConversationEmbeddingWatcher } from './ConversationEmbeddingWatcher';
import { IndexingQueue, type IndexingProgress } from './IndexingQueue';
import { EmbeddingStatusBar } from './EmbeddingStatusBar';
import { createRetrievalDreamService, RetrievalDream } from './adapter/createRetrievalDreamService';
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

/** Command id of the manual "dream now" command; removed again on stop. */
const DREAM_COMMAND_ID = 'consolidate-retrieval-memory';

/** Event name used on the manager's private Events bus. */
const STATE_EVENT = 'state-change';

/**
 * Snapshot of the embedding runtime, for status surfaces.
 *
 * `enabled` is whether semantic search is turned on for this device (always
 * false on mobile). `initialized` is whether the engine, watchers and queue are
 * running. `progress` is the latest indexing progress event, or null when
 * nothing has been reported since the last start.
 */
export interface EmbeddingRuntimeStatus {
  enabled: boolean;
  initialized: boolean;
  indexing: boolean;
  paused: boolean;
  progress: IndexingProgress | null;
}

/** Stored index sizes plus runtime state. Counts are read even while turned off. */
export interface EmbeddingStats {
  enabled: boolean;
  initialized: boolean;
  noteCount: number;
  traceCount: number;
  conversationChunkCount: number;
  /** Distinct conversations that have at least one embedded chunk. */
  conversationCount: number;
  indexingInProgress: boolean;
  indexingPaused: boolean;
}

export type EmbeddingStateListener = (status: EmbeddingRuntimeStatus) => void;

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
  /**
   * Handle for the deferred runBackgroundIndexing kick-off, so shutdown() can
   * cancel it. A bare window.setTimeout here is unclearable: nothing else holds
   * the id, and the callback fires ~3s later against whatever state the plugin
   * is in by then — including an unloaded one, whose database handle is closed.
   */
  private backgroundIndexingTimer: number | null = null;
  private backgroundIndexingWork: Promise<void> | null = null;
  private shuttingDown = false;

  /**
   * The periodic dream-cycle interval. Kept so a runtime stop can clear it;
   * registerInterval alone only clears it at plugin unload.
   */
  private dreamInterval: number | null = null;
  private dreamCommandRegistered = false;

  /**
   * Bumped by every teardown. A background indexing chain captures the value
   * it started under and stops between phases once it changes, so turning
   * semantic search off cannot let the next phase start against a torn-down
   * queue.
   */
  private runGeneration = 0;

  /** Serializes setEnabled/deleteIndex so rapid toggles apply in order. */
  private transition: Promise<void> = Promise.resolve();

  private readonly events = new Events();
  private queueProgressRef: EventRef | null = null;
  private lastProgress: IndexingProgress | null = null;

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
    if (this.shuttingDown || !this.isEnabled || this.isInitialized) {
      return;
    }

    try {
      // Create components
      this.engine = new EmbeddingEngine();
      this.service = new EmbeddingService(this.app, this.db, this.engine);
      this.watcher = new EmbeddingWatcher(this.app, this.service);
      this.queue = new IndexingQueue(this.app, this.service, this.db);
      this.statusBar = new EmbeddingStatusBar(this.plugin, this.queue);
      this.lastProgress = null;

      // Relay queue progress to status subscribers (the settings fold).
      this.queueProgressRef = this.queue.on('progress', (...data: unknown[]) => {
        this.lastProgress = (data[0] as IndexingProgress | undefined) ?? null;
        this.emitState();
      });

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
      this.backgroundIndexingTimer = window.setTimeout(() => {
        this.backgroundIndexingTimer = null;
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

    this.emitState();
  }

  /**
   * Turn semantic search on or off for this session, without a restart.
   *
   * Turning on builds fresh components and schedules indexing; the index kept
   * on this device means only notes that changed are re-embedded, and the
   * prune pass drops vectors of notes deleted or renamed while it was off.
   * Turning off stops the watchers, the queue, the status bar, the dream cycle
   * and the engine, and leaves the stored vectors in place (see deleteIndex).
   *
   * Idempotent, a no-op on mobile and after shutdown(), and serialized: two
   * quick toggles apply in the order they were made. Turning on while on but
   * not running (an earlier start failed) tries again.
   *
   * @throws when the change could not be applied, so the caller can say so.
   *   Later toggles still run: the queue keeps a settled copy.
   */
  setEnabled(enabled: boolean): Promise<void> {
    const next = this.transition.then(async () => {
      if (this.shuttingDown || Platform.isMobile) {
        return;
      }

      if (enabled) {
        if (this.isEnabled && this.isInitialized) {
          return;
        }
        this.isEnabled = true;
        this.initialize();
        if (!this.isInitialized) {
          // initialize() logs and swallows its own error. Drop whatever it
          // built before failing, so a retry starts clean.
          await this.teardown();
          this.emitState();
          throw new Error('Semantic search could not start.');
        }
        return;
      }

      if (!this.isEnabled) {
        return;
      }
      this.isEnabled = false;
      await this.teardown();
      this.emitState();
    });
    this.transition = next.catch((error) => {
      console.error('[EmbeddingManager] Failed to apply the semantic search setting:', error);
    });
    return next;
  }

  /**
   * Delete the stored note, trace and conversation vectors on this device.
   *
   * Allowed only while semantic search is turned off, so it can never race the
   * indexing queue. The learned retrieval adapter (AdapterStore) is kept: it is
   * a separate file, and it stays valid for the same embedding model.
   *
   * @throws Error when semantic search is on.
   */
  async deleteIndex(): Promise<void> {
    const run = this.transition.then(async () => {
      if (this.isEnabled || this.isInitialized) {
        throw new Error('Turn semantic search off before deleting its index.');
      }
      await this.db.clearEmbeddingIndex();
      this.lastProgress = null;
    });
    // A failed delete must not wedge later toggles behind a rejected promise.
    this.transition = run.catch(() => undefined);
    await run;
    this.emitState();
  }

  /**
   * Shutdown the embedding system
   * Called during plugin unload
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // Cleared before anything else on purpose: this timer is the one thing
    // that can still fire after shutdown() returns, so it is cancelled
    // unconditionally rather than behind a flag that may have changed.
    if (this.backgroundIndexingTimer !== null) {
      window.clearTimeout(this.backgroundIndexingTimer);
      this.backgroundIndexingTimer = null;
    }

    try {
      // Let an in-flight toggle or delete finish before tearing down, so the
      // two never interleave against the same components.
      await this.transition;
      await this.teardown();
    } catch (error) {
      console.error('[EmbeddingManager] Shutdown failed:', error);
    } finally {
      // Even a failing watcher or engine cleanup must not leave the accepted
      // background phase writing after the lifecycle closes its cache.
      await this.backgroundIndexingWork;
    }
  }

  /**
   * Stop every running component and drop it. Shared by shutdown() and by
   * turning semantic search off. Safe to call when nothing is running.
   *
   * Order matters: cancel and unsubscribe first, then wait for the indexing
   * phase that was already running to persist its final progress, and only
   * then dispose the engine it may still be using.
   */
  private async teardown(): Promise<void> {
    this.runGeneration++;

    // Anything still holding this service (an open task modal, a dream cycle or
    // a search already under way) must get the disabled answers from here on,
    // not wake the engine back up after it is disposed below.
    this.service?.disable();

    if (this.backgroundIndexingTimer !== null) {
      window.clearTimeout(this.backgroundIndexingTimer);
      this.backgroundIndexingTimer = null;
    }

    this.stopRetrievalLearning();

    try {
      // Cancel indexing and remove all listeners
      if (this.queue) {
        if (this.queueProgressRef) {
          this.queue.offref(this.queueProgressRef);
          this.queueProgressRef = null;
        }
        this.queue.destroy();
      }

      // Stop watching vault events
      if (this.watcher) {
        this.watcher.stop();
      }

      // Stop watching conversation events
      if (this.conversationWatcher) {
        await this.conversationWatcher.shutdown();
      }

      // Clean up status bar (removes progress listener and the item itself)
      if (this.statusBar) {
        this.statusBar.destroy();
      }

      // Cancellation stops new rows; the running indexer still persists its
      // final progress. Finish that work before the lifecycle closes SQLite.
      await this.backgroundIndexingWork;

      // Keep the engine available until its canceled indexing call settles.
      if (this.engine) {
        await this.engine.dispose();
      }
    } finally {
      this.engine = null;
      this.service = null;
      this.watcher = null;
      this.conversationWatcher = null;
      this.queue = null;
      this.statusBar = null;
      this.isInitialized = false;
      this.lastProgress = null;
    }
  }

  /**
   * Re-derive embeddings after the cache database was thrown away and rebuilt.
   *
   * `SQLiteMaintenanceService.clearAllData()` DROPs `conversation_embeddings`
   * and clears `embedding_backfill_state` at the start of every full rebuild.
   * The JSONL replay restores conversations and messages but knows nothing
   * about their embeddings, so without this a mid-session "Nexus: Rebuild
   * cache" silently leaves chat search dead for the rest of the session.
   *
   * The in-flight phase is cancelled first: the phases are gated on
   * `isRunning`, so a re-index requested while the long note walk is running
   * would otherwise no-op. `cancel()` does not set the queue's `destroyed`
   * flag, which is what makes the restart below legal.
   */
  async reindexAfterCacheRebuild(): Promise<void> {
    if (this.shuttingDown || !this.isEnabled || !this.queue) {
      return;
    }

    try {
      this.queue.cancel();
      await this.waitForQueueIdle();
      // isIndexing can become false before the canceled phase's final save.
      // Finish the old chain before requesting a fresh, coalesced run.
      await this.backgroundIndexingWork;
      await this.runBackgroundIndexing();
    } catch (error) {
      console.error('[EmbeddingManager] Re-index after cache rebuild failed:', error);
    }
  }

  /**
   * Wait for the queue to observe its own cancellation. Bounded: if the phase
   * refuses to settle we start anyway, and the `isRunning` guards make the
   * re-index a no-op rather than letting two walks run at once.
   */
  private async waitForQueueIdle(timeoutMs = 10_000): Promise<void> {
    const startedAt = Date.now();
    while (this.queue?.isIndexing() && Date.now() - startedAt < timeoutMs) {
      await new Promise(resolve => window.setTimeout(resolve, 100));
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
   * Whether semantic search is turned on for this device, whether or not the
   * engine has finished starting. Always false on mobile.
   */
  isTurnedOn(): boolean {
    return this.isEnabled;
  }

  /** Synchronous snapshot for a first paint; subscribe for updates. */
  getStatus(): EmbeddingRuntimeStatus {
    return {
      enabled: this.isEnabled,
      initialized: this.isInitialized,
      indexing: this.queue?.isIndexing() ?? false,
      paused: this.queue?.isIndexingPaused() ?? false,
      progress: this.lastProgress
    };
  }

  /**
   * Current indexing progress: the queue's own view while it is running,
   * otherwise the last event it reported, otherwise null.
   */
  getProgress(): IndexingProgress | null {
    if (this.queue?.isIndexing()) {
      return this.queue.getProgress();
    }
    return this.lastProgress;
  }

  /** Pause the running indexing pass. A no-op when nothing is indexing. */
  pauseIndexing(): void {
    this.queue?.pause();
    this.emitState();
  }

  /** Resume a paused indexing pass. */
  resumeIndexing(): void {
    this.queue?.resume();
    this.emitState();
  }

  /**
   * Subscribe to state changes: start, stop, index deletion and every
   * indexing progress event.
   *
   * @returns A function that removes the listener.
   */
  onStateChange(listener: EmbeddingStateListener): () => void {
    const ref = this.events.on(STATE_EVENT, (...data: unknown[]) => {
      listener(data[0] as EmbeddingRuntimeStatus);
    });
    return () => this.events.offref(ref);
  }

  private emitState(): void {
    try {
      this.events.trigger(STATE_EVENT, this.getStatus());
    } catch (error) {
      console.error('[EmbeddingManager] A state listener failed:', error);
    }
  }

  /**
   * Get statistics about the embedding system.
   *
   * The counts come straight from the cache database, so they are reported
   * while semantic search is turned off as well: the off state shows how much
   * index is being kept. Each count answers 0 on its own when its table cannot
   * be read.
   */
  async getStats(): Promise<EmbeddingStats> {
    const [noteCount, traceCount, conversationChunkCount, conversationCount] = await Promise.all([
      this.countOrZero('SELECT COUNT(*) as count FROM embedding_metadata'),
      this.countOrZero('SELECT COUNT(*) as count FROM trace_embedding_metadata'),
      this.countOrZero('SELECT COUNT(*) as count FROM conversation_embedding_metadata'),
      this.countOrZero('SELECT COUNT(DISTINCT conversationId) as count FROM conversation_embedding_metadata')
    ]);

    return {
      enabled: this.isEnabled,
      initialized: this.isInitialized,
      noteCount,
      traceCount,
      conversationChunkCount,
      conversationCount,
      indexingInProgress: this.queue?.isIndexing() ?? false,
      indexingPaused: this.queue?.isIndexingPaused() ?? false
    };
  }

  private async countOrZero(sql: string): Promise<number> {
    try {
      const row = await this.db.queryOne<{ count: number }>(sql);
      return Number(row?.count ?? 0) || 0;
    } catch {
      return 0;
    }
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
        db: this.db,
        fs: this.app.vault.adapter,
        getSettings: () => (pluginSettings as never),
        configDir: this.app.vault.configDir
      });

      // Apply a previously-trained adapter on startup (identity if none).
      void this.retrievalDream.loadAndApply().catch((error) => {
        console.error('[EmbeddingManager] Failed to load retrieval adapter:', error);
      });

      // Periodic consolidation, unless explicitly disabled. The id is kept so
      // turning semantic search off can clear it; registerInterval still
      // covers plugin unload.
      if (pluginSettings?.embeddings?.retrievalLearning !== false) {
        const interval = window.setInterval(() => {
          void this.runDreamCycle(false);
        }, DREAM_INTERVAL_MS);
        this.dreamInterval = interval;
        this.plugin.registerInterval(interval);
      }

      this.plugin.addCommand({
        id: DREAM_COMMAND_ID,
        name: 'Consolidate retrieval memory (dream now)',
        callback: () => { void this.runDreamCycle(true); }
      });
      this.dreamCommandRegistered = true;
    } catch (error) {
      console.error('[EmbeddingManager] Failed to initialize retrieval learning:', error);
    }
  }

  /**
   * Undo initRetrievalLearning: clear the dream interval and remove the
   * command, so a stopped manager leaves nothing scheduled or advertised.
   * The persisted adapter file is not touched.
   */
  private stopRetrievalLearning(): void {
    if (this.dreamInterval !== null) {
      window.clearInterval(this.dreamInterval);
      this.dreamInterval = null;
    }

    if (this.dreamCommandRegistered) {
      this.dreamCommandRegistered = false;
      try {
        this.plugin.removeCommand(DREAM_COMMAND_ID);
      } catch (error) {
        console.error('[EmbeddingManager] Failed to remove the dream command:', error);
      }
    }

    this.retrievalDream = null;
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
        const via = report.winner ? ` via ${report.winner}` : '';
        new Notice(
          `Nexus consolidated retrieval memory — search relevance improved${via} ` +
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

  private runBackgroundIndexing(): Promise<void> {
    if (this.shuttingDown || !this.queue) {
      return Promise.resolve();
    }
    if (this.backgroundIndexingWork) return this.backgroundIndexingWork;
    const work = this.runIndexingPhases();
    this.backgroundIndexingWork = work;
    void work.finally(() => {
      if (this.backgroundIndexingWork === work) this.backgroundIndexingWork = null;
    });
    return work;
  }

  private async runIndexingPhases(): Promise<void> {
    const queue = this.queue;
    if (!queue) {
      return;
    }
    const generation = this.runGeneration;
    const stopped = (): boolean => this.shuttingDown || generation !== this.runGeneration;

    try {
      // Prune first. Vectors of notes deleted or renamed while semantic search
      // was off, and of conversations deleted meanwhile, are otherwise never
      // removed: the passes below only walk what still exists. Running it on
      // every pass covers startup, turning search back on and a cache rebuild.
      await queue.pruneMissingNotes();
      if (stopped()) return;
      await queue.pruneMissingConversations();
      if (stopped()) return;

      // Cheapest-first, and deliberately so.
      //
      // The three phases are independent - conversations read conversations/
      // messages, traces read memory_traces, notes read the vault - so the order
      // is free, and it should be driven by how long each phase makes the others
      // wait. A vault with 18k notes takes hours to index; the few hundred
      // conversations behind it then have no chat search for that whole time.
      // Since clearAllData() drops conversation embeddings on every full
      // rebuild, that is exactly the window a rebuild opens, every time.
      //
      // Conversations first, notes last: the small, high-value indexes come back
      // in seconds and the long vault walk runs behind them.

      // Phase 1: Backfill existing conversations (idempotent, resumable)
      await queue.startConversationIndex();
      if (stopped()) return;

      // Phase 2: Backfill existing traces (from migration)
      await queue.startTraceIndex();
      if (stopped()) return;

      // Phase 3: Index all notes - longest by far, so it goes last
      await queue.startFullIndex();
    } catch (error) {
      console.error('[EmbeddingManager] Background indexing failed:', error);
    }
  }
}
