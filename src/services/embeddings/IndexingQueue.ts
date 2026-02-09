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
 * - Saves DB every 10 notes
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

import { App, TFile } from 'obsidian';
import { EventEmitter } from 'events';
import { EmbeddingService } from './EmbeddingService';
import { preprocessContent, hashContent } from './EmbeddingUtils';
import { TraceIndexer } from './TraceIndexer';
import { ConversationIndexer } from './ConversationIndexer';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';

export interface IndexingProgress {
  phase: 'idle' | 'loading_model' | 'indexing' | 'complete' | 'paused' | 'error';
  totalNotes: number;
  processedNotes: number;
  currentNote: string | null;
  estimatedTimeRemaining: number | null;  // seconds
  error?: string;
}

/**
 * Background indexing queue for notes, traces, and conversations.
 *
 * Processes notes one at a time with UI yielding to keep Obsidian responsive.
 * Emits 'progress' events that can be consumed by UI components.
 */
export class IndexingQueue extends EventEmitter {
  private app: App;
  private embeddingService: EmbeddingService;
  private db: SQLiteCacheManager;

  private queue: string[] = [];
  private isRunning = false;
  private isPaused = false;
  private abortController: AbortController | null = null;

  // Tuning parameters
  private readonly BATCH_SIZE = 1;           // Process one at a time for memory
  private readonly YIELD_INTERVAL_MS = 50;   // Yield to UI between notes
  private readonly SAVE_INTERVAL = 10;       // Save DB every N notes
  private readonly CONVERSATION_YIELD_INTERVAL = 5;  // Yield every N conversations during backfill

  private processedCount = 0;
  private totalCount = 0;
  private startTime = 0;
  private processingTimes: number[] = [];    // Rolling average for ETA

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
    if (this.isRunning) {
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

    // Filter to notes not already indexed (or with changed content)
    const needsIndexing = await this.filterUnindexedNotes(allNotes);

    if (needsIndexing.length === 0) {
      this.emitProgress({
        phase: 'complete',
        totalNotes: 0,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null
      });
      return;
    }

    this.queue = needsIndexing.map(f => f.path);
    this.totalCount = this.queue.length;
    this.processedCount = 0;
    this.startTime = Date.now();
    this.processingTimes = [];
    this.abortController = new AbortController();

    await this.processQueue();
  }

  /**
   * Start indexing of all memory traces (backfill existing traces)
   * Delegates to TraceIndexer for the actual work.
   */
  async startTraceIndex(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    if (!this.embeddingService.isServiceEnabled()) {
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();

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
          estimatedTimeRemaining: null
        });
      },
      this.SAVE_INTERVAL,
      this.YIELD_INTERVAL_MS
    );

    this.emitProgress({
      phase: 'indexing',
      totalNotes: 0,
      processedNotes: 0,
      currentNote: 'traces',
      estimatedTimeRemaining: null
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
        estimatedTimeRemaining: null
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
    console.log('[DEBUG] IndexingQueue.startConversationIndex() entered: isRunning =', this.isRunning, ', isServiceEnabled =', this.embeddingService.isServiceEnabled());
    if (this.isRunning) {
      console.log('[DEBUG] IndexingQueue.startConversationIndex() early return: isRunning = true');
      return;
    }

    if (!this.embeddingService.isServiceEnabled()) {
      console.log('[DEBUG] IndexingQueue.startConversationIndex() early return: service not enabled');
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();

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
          estimatedTimeRemaining: null
        });
      },
      this.SAVE_INTERVAL
    );

    this.emitProgress({
      phase: 'indexing',
      totalNotes: 0,
      processedNotes: 0,
      currentNote: 'conversations',
      estimatedTimeRemaining: null
    });

    try {
      console.log('[DEBUG] IndexingQueue.startConversationIndex(): calling conversationIndexer.start()');
      const result = await this.conversationIndexer.start(
        this.abortController.signal,
        this.CONVERSATION_YIELD_INTERVAL
      );
      console.log('[DEBUG] IndexingQueue.startConversationIndex(): conversationIndexer.start() returned: total =', result.total, ', processed =', result.processed);

      this.emitProgress({
        phase: 'complete',
        totalNotes: result.total,
        processedNotes: result.processed,
        currentNote: null,
        estimatedTimeRemaining: null
      });
    } finally {
      console.log('[DEBUG] IndexingQueue.startConversationIndex() finally block: cleaning up');
      this.isRunning = false;
      this.conversationIndexer = null;
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
      estimatedTimeRemaining: null
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
  cancel(): void {
    if (!this.isRunning) return;
    this.abortController?.abort();
    this.queue = [];
  }

  /**
   * Clean up all resources (called on plugin unload)
   */
  destroy(): void {
    this.cancel();
    this.removeAllListeners();
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

    return {
      phase: this.isPaused ? 'paused' : 'indexing',
      totalNotes: this.totalCount,
      processedNotes: this.processedCount,
      currentNote: this.queue.length > 0 ? this.queue[0] : null,
      estimatedTimeRemaining: this.calculateETA()
    };
  }

  // ---------------------------------------------------------------------------
  // Private: note indexing
  // ---------------------------------------------------------------------------

  /**
   * Filter to only notes that need (re)indexing
   */
  private async filterUnindexedNotes(notes: TFile[]): Promise<TFile[]> {
    const needsIndexing: TFile[] = [];

    for (const note of notes) {
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
      estimatedTimeRemaining: null
    });

    try {
      await this.embeddingService.initialize();

      this.emitProgress({
        phase: 'indexing',
        totalNotes: this.totalCount,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null
      });

      while (this.queue.length > 0) {
        if (this.abortController?.signal.aborted) {
          this.emitProgress({
            phase: 'paused',
            totalNotes: this.totalCount,
            processedNotes: this.processedCount,
            currentNote: null,
            estimatedTimeRemaining: null
          });
          break;
        }

        if (this.isPaused) {
          await this.waitForResume();
          continue;
        }

        const notePath = this.queue.shift()!;
        const noteStart = Date.now();

        try {
          this.emitProgress({
            phase: 'indexing',
            totalNotes: this.totalCount,
            processedNotes: this.processedCount,
            currentNote: notePath,
            estimatedTimeRemaining: this.calculateETA()
          });

          await this.embeddingService.embedNote(notePath);
          this.processedCount++;

          const elapsed = Date.now() - noteStart;
          this.processingTimes.push(elapsed);
          if (this.processingTimes.length > 20) {
            this.processingTimes.shift();
          }

          if (this.processedCount % this.SAVE_INTERVAL === 0) {
            await this.db.save();
          }

        } catch (error) {
          console.error(`[IndexingQueue] Failed to embed ${notePath}:`, error);
        }

        await new Promise(r => setTimeout(r, this.YIELD_INTERVAL_MS));
      }

      await this.db.save();

      this.emitProgress({
        phase: 'complete',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null
      });

    } catch (error: unknown) {
      console.error('[IndexingQueue] Processing failed:', error);
      this.emitProgress({
        phase: 'error',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null,
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
      await new Promise(r => setTimeout(r, 100));
    }
  }

  /**
   * Emit progress event
   */
  private emitProgress(progress: IndexingProgress): void {
    this.emit('progress', progress);
  }
}
