/**
 * Location: src/services/embeddings/IndexingQueue.ts
 * Purpose: Top-level coordinator for background embedding indexing with progress
 *          tracking. Manages the shared queue state (pause/resume/cancel) and
 *          delegates domain-specific indexing to TraceIndexer and
 *          ConversationIndexer.
 *
 * Features:
 * - Processes one note at a time (memory conscious)
 * - Yields to UI between notes (50ms)
 * - Progress events with ETA calculation
 * - Pause/resume/cancel controls
 * - Resumable via content hash comparison
 * - Saves the DB on a size-aware cadence (see CacheSavePolicy)
 * - Delegates conversation backfill to ConversationIndexer
 * - Delegates trace backfill to TraceIndexer
 *
 * Relationships:
 * - Uses EmbeddingService for embedding notes
 * - Uses SQLiteCacheManager for periodic saves and note hash lookups
 * - Uses TraceIndexer for trace backfill
 * - Uses ConversationIndexer for conversation backfill
 * - Emits progress events for UI updates (consumed by EmbeddingStatusBar)
 */

import { App, Events, TFile } from 'obsidian';
import { EmbeddingService } from './EmbeddingService';
import { preprocessContent, hashContent } from './EmbeddingUtils';
import { TraceIndexer } from './TraceIndexer';
import { ConversationIndexer } from './ConversationIndexer';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';
import {
  SaveCadence,
  describeCacheSaveFailure,
  readCacheSizeBytes,
  type CacheSaveStage
} from './CacheSavePolicy';

/** What a pass is working through. Absent on events that predate it. */
export type IndexingScope = 'notes' | 'conversations' | 'traces';

export interface IndexingProgress {
  /**
   * 'checking' is the note pass comparing every note's content hash with the
   * index before it knows what needs embedding: processed/total count notes
   * compared, not notes embedded. 'indexing' counts only real work.
   */
  phase: 'idle' | 'loading_model' | 'checking' | 'indexing' | 'complete' | 'paused' | 'error';
  totalNotes: number;
  processedNotes: number;
  currentNote: string | null;
  estimatedTimeRemaining: number | null;  // seconds
  scope?: IndexingScope;
  error?: string;
}

/**
 * Background indexing queue for notes, traces, and conversations.
 *
 * Processes notes one at a time with UI yielding to keep Obsidian responsive.
 * Emits 'progress' events that can be consumed by UI components.
 */
export class IndexingQueue extends Events {
  private app: App;
  private embeddingService: EmbeddingService;
  private db: SQLiteCacheManager;

  private queue: string[] = [];
  private isRunning = false;
  private isPaused = false;
  private abortController: AbortController | null = null;

  /**
   * Set by destroy() at plugin unload and never cleared.
   *
   * Without it this queue outlives the plugin instance that owns it. `cancel()`
   * aborts only the phase that happens to be running, but `runBackgroundIndexing`
   * awaits three phases in sequence and each one mints a fresh AbortController,
   * so aborting phase 1 does not stop phases 2 and 3 - they start *after* the
   * unload and iterate against a SQLiteCacheManager whose handle close() already
   * nulled. filterUnindexedNotes() is one db.queryOne per markdown file and
   * checks this flag as well as its controller. The result is the "Database not initialized"
   * burst that grows with every reload, exactly as NotesIndexBuilder.stop()
   * documents for the notes index.
   */
  private destroyed = false;

  // Tuning parameters
  private readonly BATCH_SIZE = 1;           // Process one at a time for memory
  private readonly YIELD_INTERVAL_MS = 50;   // Yield to UI between notes
  /**
   * Floor on how often a snapshot is written, in items.
   *
   * A floor, not the interval. The interval itself comes from CacheSavePolicy
   * and scales with the size of the database, because that is what a save
   * costs: ten notes is nearly free on a small cache and roughly 380 ms of
   * wall clock every ten notes on the 152 MB one that motivated
   * docs/plans/sqlite-cache-persistence-plan.md.
   */
  private readonly MIN_SAVE_ITEMS = 10;
  private readonly CONVERSATION_YIELD_INTERVAL = 5;  // Yield every N conversations during backfill
  /** Report the note hash check every N notes; one event per note is noise. */
  private readonly CHECK_PROGRESS_INTERVAL = 100;

  private processedCount = 0;
  private totalCount = 0;
  private startTime = 0;
  private processingTimes: number[] = [];    // Rolling average for ETA
  /** The pass in flight, so getProgress() and pause() describe it honestly. */
  private scope: IndexingScope = 'notes';
  private checking = false;

  // Domain indexers (created lazily in their start methods)
  private traceIndexer: TraceIndexer | null = null;
  private conversationIndexer: ConversationIndexer | null = null;

  constructor(
    app: App,
    embeddingService: EmbeddingService,
    db: SQLiteCacheManager
  ) {
    super();
    this.app = app;
    this.embeddingService = embeddingService;
    this.db = db;
  }

  /**
   * Start initial indexing of all notes
   */
  async startFullIndex(): Promise<void> {
    if (this.destroyed || this.isRunning) {
      return;
    }

    if (!this.embeddingService.isServiceEnabled()) {
      this.emitProgress({
        phase: 'complete',
        totalNotes: 0,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null
      });
      return;
    }

    const allNotes = this.app.vault.getMarkdownFiles();

    // Filter to notes not already indexed (or with changed content). On a
    // large vault this takes minutes, so it runs as a pass of its own: it
    // reports 'checking' with its own counts, and it can be paused and
    // cancelled like the embedding that follows.
    this.isRunning = true;
    this.scope = 'notes';
    this.abortController = this.createAbortController();
    let needsIndexing: TFile[];
    try {
      needsIndexing = await this.filterUnindexedNotes(allNotes);
    } finally {
      this.checking = false;
      this.isRunning = false;
    }

    if (this.destroyed || this.abortController.signal.aborted) {
      this.emitProgress({
        phase: 'idle',
        totalNotes: 0,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null,
        scope: 'notes'
      });
      return;
    }

    if (needsIndexing.length === 0) {
      this.emitProgress({
        phase: 'complete',
        totalNotes: 0,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null,
        scope: 'notes'
      });
      return;
    }

    this.queue = needsIndexing.map(f => f.path);
    this.totalCount = this.queue.length;
    this.processedCount = 0;
    this.startTime = Date.now();
    this.processingTimes = [];

    await this.processQueue();
  }

  /**
   * Start indexing of all memory traces (backfill existing traces)
   * Delegates to TraceIndexer for the actual work.
   */
  async startTraceIndex(): Promise<void> {
    if (this.destroyed || this.isRunning) {
      return;
    }

    if (!this.embeddingService.isServiceEnabled()) {
      return;
    }

    this.isRunning = true;
    this.scope = 'traces';
    this.totalCount = 0;
    this.processedCount = 0;
    this.abortController = this.createAbortController();

    this.traceIndexer = new TraceIndexer(
      this.db,
      this.embeddingService,
      (progress) => {
        this.totalCount = progress.totalTraces;
        this.processedCount = progress.processedTraces;
        this.emitProgress({
          phase: 'indexing',
          totalNotes: progress.totalTraces,
          processedNotes: progress.processedTraces,
          currentNote: 'traces',
          estimatedTimeRemaining: null,
          scope: 'traces'
        });
      },
      this.MIN_SAVE_ITEMS,
      this.YIELD_INTERVAL_MS
    );

    this.emitProgress({
      phase: 'indexing',
      totalNotes: 0,
      processedNotes: 0,
      currentNote: 'traces',
      estimatedTimeRemaining: null,
      scope: 'traces'
    });

    try {
      const result = await this.traceIndexer.start(
        this.abortController.signal,
        () => this.isPaused,
        () => this.waitForResume()
      );

      this.emitProgress({
        phase: 'complete',
        totalNotes: result.total,
        processedNotes: result.processed,
        currentNote: null,
        estimatedTimeRemaining: null,
        scope: 'traces'
      });
    } finally {
      this.isRunning = false;
      this.traceIndexer = null;
    }
  }

  /**
   * Backfill embeddings for all existing conversations.
   * Delegates to ConversationIndexer for the actual work.
   */
  async startConversationIndex(): Promise<void> {
    if (this.destroyed || this.isRunning) {
      return;
    }

    if (!this.embeddingService.isServiceEnabled()) {
      return;
    }

    this.isRunning = true;
    this.scope = 'conversations';
    this.totalCount = 0;
    this.processedCount = 0;
    this.abortController = this.createAbortController();

    this.conversationIndexer = new ConversationIndexer(
      this.db,
      this.embeddingService,
      (progress) => {
        this.totalCount = progress.totalConversations;
        this.processedCount = progress.processedConversations;
        this.emitProgress({
          phase: 'indexing',
          totalNotes: progress.totalConversations,
          processedNotes: progress.processedConversations,
          currentNote: 'conversations',
          estimatedTimeRemaining: null,
          scope: 'conversations'
        });
      },
      this.MIN_SAVE_ITEMS
    );

    this.emitProgress({
      phase: 'indexing',
      totalNotes: 0,
      processedNotes: 0,
      currentNote: 'conversations',
      estimatedTimeRemaining: null,
      scope: 'conversations'
    });

    try {
      const result = await this.conversationIndexer.start(
        this.abortController.signal,
        this.CONVERSATION_YIELD_INTERVAL
      );

      this.emitProgress({
        phase: 'complete',
        totalNotes: result.total,
        processedNotes: result.processed,
        currentNote: null,
        estimatedTimeRemaining: null,
        scope: 'conversations'
      });
    } finally {
      this.isRunning = false;
      this.conversationIndexer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Prune passes
  // ---------------------------------------------------------------------------

  /**
   * Remove the vectors of notes that no longer exist in the vault.
   *
   * The watcher removes a vector when a note is deleted or renamed, but only
   * while semantic search is running. A note deleted or renamed while it was
   * off keeps its old vector forever otherwise: the note walk only visits
   * files that exist, so nothing ever asks about the old path again.
   *
   * Refuses to prune when the vault reports no markdown files at all. That
   * is far more likely to be a vault that has not finished loading than one
   * whose every note was deleted, and pruning then would throw away the
   * whole index.
   *
   * @returns The number of note vectors removed.
   */
  async pruneMissingNotes(): Promise<number> {
    if (this.destroyed || !this.embeddingService.isServiceEnabled()) {
      return 0;
    }

    const rows = await this.db.query<{ notePath: string }>(
      'SELECT notePath FROM embedding_metadata'
    );
    if (rows.length === 0 || this.app.vault.getMarkdownFiles().length === 0) {
      return 0;
    }

    let removed = 0;
    for (const row of rows) {
      if (this.destroyed) break;
      if (this.app.vault.getAbstractFileByPath(row.notePath)) continue;
      try {
        await this.embeddingService.removeEmbedding(row.notePath);
        removed++;
      } catch (error) {
        console.error(`[IndexingQueue] Failed to prune the vector for ${row.notePath}:`, error);
      }
    }

    if (removed > 0) {
      await this.saveAfterPrune('notes');
    }
    return removed;
  }

  /**
   * Remove the vectors of conversations that no longer exist in the cache.
   *
   * Same reasoning as pruneMissingNotes: a conversation deleted while
   * semantic search was off never reached onConversationDeleted. Skipped when
   * the conversations table is empty, which means the cache has not been
   * replayed yet rather than that every chat was deleted.
   *
   * @returns The number of conversations whose vectors were removed.
   */
  async pruneMissingConversations(): Promise<number> {
    if (this.destroyed || !this.embeddingService.isServiceEnabled()) {
      return 0;
    }

    const known = await this.db.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM conversations'
    );
    if (!known || Number(known.count) === 0) {
      return 0;
    }

    const rows = await this.db.query<{ conversationId: string }>(
      `SELECT DISTINCT conversationId FROM conversation_embedding_metadata
       WHERE conversationId NOT IN (SELECT id FROM conversations)`
    );

    let removed = 0;
    for (const row of rows) {
      if (this.destroyed) break;
      try {
        await this.embeddingService.removeConversationEmbeddings(row.conversationId);
        removed++;
      } catch (error) {
        console.error(`[IndexingQueue] Failed to prune vectors for conversation ${row.conversationId}:`, error);
      }
    }

    if (removed > 0) {
      await this.saveAfterPrune('conversations');
    }
    return removed;
  }

  /** Persist a prune. Never throws: the rows are gone from memory either way. */
  private async saveAfterPrune(kind: 'notes' | 'conversations'): Promise<void> {
    try {
      await this.db.save();
    } catch (error) {
      console.error(`[IndexingQueue] Saving after pruning ${kind} failed:`, error);
    }
  }

  // ---------------------------------------------------------------------------
  // Queue controls
  // ---------------------------------------------------------------------------

  /**
   * Pause indexing (can resume later)
   */
  pause(): void {
    if (!this.isRunning) return;

    this.isPaused = true;
    this.emitProgress({
      phase: 'paused',
      totalNotes: this.totalCount,
      processedNotes: this.processedCount,
      currentNote: null,
      estimatedTimeRemaining: null,
      scope: this.scope
    });
  }

  /**
   * Resume paused indexing
   */
  resume(): void {
    if (!this.isRunning || !this.isPaused) return;
    this.isPaused = false;
  }

  /**
   * Cancel indexing entirely
   */
  /**
   * A fresh controller for a phase, already aborted if the queue is destroyed.
   *
   * Closes the window between a phase's `destroyed` guard and its controller
   * assignment: an unload landing in that gap aborts the outgoing controller,
   * and without this the incoming one would come up live and run on regardless.
   */
  private createAbortController(): AbortController {
    const controller = new AbortController();
    if (this.destroyed) {
      controller.abort();
    }
    return controller;
  }

  cancel(): void {
    // Deliberately NOT gated on isRunning: the gap between phases runs with
    // isRunning === false, and that is precisely a window an unload has to be
    // able to interrupt. The note hash check is a running pass of its own and
    // stops on this abort.
    this.abortController?.abort();
    this.queue = [];
  }

  /**
   * Clean up all resources (called on plugin unload)
   */
  destroy(): void {
    this.destroyed = true;
    this.cancel();
    // Obsidian's Events doesn't have removeAllListeners — handled by GC after cancel()
  }

  // ---------------------------------------------------------------------------
  // Status queries
  // ---------------------------------------------------------------------------

  /**
   * Check if indexing is currently running
   */
  isIndexing(): boolean {
    return this.isRunning;
  }

  /**
   * Check if indexing is paused
   */
  isIndexingPaused(): boolean {
    return this.isPaused;
  }

  /**
   * Get current progress
   */
  getProgress(): IndexingProgress {
    if (!this.isRunning) {
      return {
        phase: 'idle',
        totalNotes: 0,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null
      };
    }

    if (this.checking) {
      return {
        phase: this.isPaused ? 'paused' : 'checking',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null,
        scope: this.scope
      };
    }

    return {
      phase: this.isPaused ? 'paused' : 'indexing',
      totalNotes: this.totalCount,
      processedNotes: this.processedCount,
      currentNote: this.queue.length > 0 ? this.queue[0] : null,
      estimatedTimeRemaining: this.calculateETA(),
      scope: this.scope
    };
  }

  // ---------------------------------------------------------------------------
  // Private: note indexing
  // ---------------------------------------------------------------------------

  /**
   * Filter to only notes that need (re)indexing.
   *
   * Reports phase 'checking' with notes compared so far over the vault's note
   * count, every CHECK_PROGRESS_INTERVAL notes. Without it the status bar
   * showed nothing (or a stale "Indexing: 0/N") for the minutes this takes on
   * a large vault, then jumped to a much smaller count of notes that changed.
   */
  private async filterUnindexedNotes(notes: TFile[]): Promise<TFile[]> {
    const needsIndexing: TFile[] = [];
    this.checking = true;
    this.totalCount = notes.length;
    this.processedCount = 0;
    this.emitCheckingProgress();

    for (const note of notes) {
      if (this.destroyed || this.abortController?.signal.aborted) break;
      if (this.isPaused) {
        await this.waitForResume();
        if (this.abortController?.signal.aborted) break;
      }
      this.processedCount++;
      if (this.processedCount % this.CHECK_PROGRESS_INTERVAL === 0) {
        this.emitCheckingProgress();
      }
      try {
        const content = await this.app.vault.cachedRead(note);
        const contentHash = hashContent(preprocessContent(content) ?? '');

        const existing = await this.db.queryOne<{ contentHash: string }>(
          'SELECT contentHash FROM embedding_metadata WHERE notePath = ?',
          [note.path]
        );

        if (!existing || existing.contentHash !== contentHash) {
          needsIndexing.push(note);
        }
      } catch {
        needsIndexing.push(note);
      }
    }

    return needsIndexing;
  }

  private emitCheckingProgress(): void {
    this.emitProgress({
      phase: 'checking',
      totalNotes: this.totalCount,
      processedNotes: this.processedCount,
      currentNote: null,
      estimatedTimeRemaining: null,
      scope: 'notes'
    });
  }

  /**
   * Process the note queue with memory-conscious batching
   */
  private async processQueue(): Promise<void> {
    this.isRunning = true;
    this.emitProgress({
      phase: 'loading_model',
      totalNotes: this.totalCount,
      processedNotes: 0,
      currentNote: null,
      estimatedTimeRemaining: null,
      scope: 'notes'
    });

    try {
      await this.embeddingService.initialize();

      // initialize() swallows a model that failed to load and turns the
      // service off. Every embedNote() after that is a silent no-op, so
      // walking the queue anyway reported "complete, N of N" over an empty
      // index. Say what happened instead.
      if (!this.embeddingService.isServiceEnabled()) {
        this.queue = [];
        throw new Error('The embedding model could not be loaded');
      }

      this.emitProgress({
        phase: 'indexing',
        totalNotes: this.totalCount,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null,
        scope: 'notes'
      });

      const saveCadence = new SaveCadence({ minItems: this.MIN_SAVE_ITEMS, db: this.db });

      while (this.queue.length > 0) {
        if (this.destroyed || this.abortController?.signal.aborted) {
          this.emitProgress({
            phase: 'paused',
            totalNotes: this.totalCount,
            processedNotes: this.processedCount,
            currentNote: null,
            estimatedTimeRemaining: null,
            scope: 'notes'
          });
          break;
        }

        if (this.isPaused) {
          await this.waitForResume();
          continue;
        }

        const notePath = this.queue.shift();
        if (!notePath) {
          continue;
        }
        const noteStart = Date.now();

        try {
          this.emitProgress({
            phase: 'indexing',
            totalNotes: this.totalCount,
            processedNotes: this.processedCount,
            currentNote: notePath,
            estimatedTimeRemaining: this.calculateETA(),
            scope: 'notes'
          });

          await this.embeddingService.embedNote(notePath);
          this.processedCount++;
          saveCadence.recordItem();

          const elapsed = Date.now() - noteStart;
          this.processingTimes.push(elapsed);
          if (this.processingTimes.length > 20) {
            this.processingTimes.shift();
          }

        } catch (error) {
          console.error(`[IndexingQueue] Failed to embed ${notePath}:`, error);
        }

        // Outside the per-note try, which is the whole point. The save used to
        // sit inside it, so a snapshot failure was logged as
        // "Failed to embed <path>" against whichever note happened to be tenth
        // although its embedding had already succeeded and its vector was
        // already in the database.
        if (saveCadence.shouldSave()) {
          await this.persistCache(saveCadence, 'periodic');
        }

        await new Promise(r => window.setTimeout(r, this.YIELD_INTERVAL_MS));
      }

      // Non-fatal. A run that embedded four thousand notes and could not write
      // the snapshot is a partial success with a loud warning, not an aborted
      // run: the vectors are in the in-memory database, the next successful
      // save writes them, and phase `complete` is what tells everything
      // downstream the run finished.
      await this.persistCache(saveCadence, 'final');

      this.emitProgress({
        phase: 'complete',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null,
        scope: 'notes'
      });

    } catch (error: unknown) {
      console.error('[IndexingQueue] Processing failed:', error);
      this.emitProgress({
        phase: 'error',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null,
        scope: 'notes',
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.isRunning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: shared helpers
  // ---------------------------------------------------------------------------

  /**
   * Write a cache snapshot. Never throws, and says what failed when it fails.
   *
   * Both halves matter. The message names persistence and carries the byte
   * count, because a `RangeError: Array buffer allocation failed` is the
   * allocator refusing one contiguous request of roughly that size and nothing
   * in the old line said so. Swallowing keeps a failed snapshot from aborting
   * a run whose work is already done, which is how TraceIndexer has always
   * behaved and is now what all three call sites do.
   */
  private async persistCache(cadence: SaveCadence, stage: CacheSaveStage): Promise<void> {
    try {
      await this.db.save();
      // Only here, and only on the path where save() returned without
      // throwing. This is what clears the data-at-risk ceiling, and a
      // save that threw has cleared nothing.
      cadence.markSaveSuccess();
    } catch (error) {
      cadence.markSaveFailure(error);
      console.error(
        describeCacheSaveFailure('IndexingQueue', stage, readCacheSizeBytes(this.db)),
        error
      );
    } finally {
      cadence.markSaveAttempt();
    }
  }

  /**
   * Calculate estimated time remaining
   */
  private calculateETA(): number | null {
    if (this.processingTimes.length < 3) return null;

    const avgTime = this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length;
    const remaining = this.totalCount - this.processedCount;
    return Math.round((remaining * avgTime) / 1000);
  }

  /**
   * Wait for resume signal
   */
  private async waitForResume(): Promise<void> {
    while (this.isPaused && !this.abortController?.signal.aborted) {
      await new Promise(r => window.setTimeout(r, 100));
    }
  }

  /**
   * Emit progress event
   */
  private emitProgress(progress: IndexingProgress): void {
    this.trigger('progress', progress);
  }
}
