/**
 * Location: src/services/embeddings/IndexingQueue.ts
 * Purpose: Background initial indexing queue with progress tracking
 *
 * Features:
 * - Processes one note at a time (memory conscious)
 * - Yields to UI between notes (50ms)
 * - Progress events with ETA calculation
 * - Pause/resume/cancel controls
 * - Resumable via content hash comparison
 * - Saves DB every 10 notes
 *
 * Relationships:
 * - Uses EmbeddingService for embedding notes
 * - Uses SQLiteCacheManager for periodic saves
 * - Emits progress events for UI updates
 */

import { App, TFile } from 'obsidian';
import { EventEmitter } from 'events';
import { EmbeddingService } from './EmbeddingService';
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
 * Background indexing queue for notes
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

  private processedCount = 0;
  private totalCount = 0;
  private startTime = 0;
  private processingTimes: number[] = [];    // Rolling average for ETA

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
   * Filter to only notes that need (re)indexing
   */
  private async filterUnindexedNotes(notes: TFile[]): Promise<TFile[]> {
    const needsIndexing: TFile[] = [];

    for (const note of notes) {
      try {
        const content = await this.app.vault.cachedRead(note);
        const contentHash = this.hashContent(this.preprocessContent(content));

        const existing = await this.db.queryOne<{ contentHash: string }>(
          'SELECT contentHash FROM embedding_metadata WHERE notePath = ?',
          [note.path]
        );

        // Needs indexing if: no embedding OR content changed
        if (!existing || existing.contentHash !== contentHash) {
          needsIndexing.push(note);
        }
      } catch {
        // Include in indexing queue anyway
        needsIndexing.push(note);
      }
    }

    return needsIndexing;
  }

  /**
   * Process the queue with memory-conscious batching
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
      // Load model (one-time, ~50-100MB)
      await this.embeddingService.initialize();

      this.emitProgress({
        phase: 'indexing',
        totalNotes: this.totalCount,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null
      });

      while (this.queue.length > 0) {
        // Check for abort/pause
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

          // Process single note - memory released after each
          await this.embeddingService.embedNote(notePath);
          this.processedCount++;

          // Track timing for ETA
          const elapsed = Date.now() - noteStart;
          this.processingTimes.push(elapsed);
          if (this.processingTimes.length > 20) {
            this.processingTimes.shift(); // Keep rolling window
          }

          // Periodic DB save (embeddings are already in DB, this ensures WAL flush)
          if (this.processedCount % this.SAVE_INTERVAL === 0) {
            await this.db.save();
          }

        } catch (error) {
          console.error(`[IndexingQueue] Failed to embed ${notePath}:`, error);
          // Continue with next note, don't fail entire queue
        }

        // Yield to UI - critical for responsiveness
        await new Promise(r => setTimeout(r, this.YIELD_INTERVAL_MS));
      }

      // Final save
      await this.db.save();

      this.emitProgress({
        phase: 'complete',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null
      });

    } catch (error: any) {
      console.error('[IndexingQueue] Processing failed:', error);
      this.emitProgress({
        phase: 'error',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null,
        error: error.message
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Calculate estimated time remaining
   */
  private calculateETA(): number | null {
    if (this.processingTimes.length < 3) return null;

    const avgTime = this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length;
    const remaining = this.totalCount - this.processedCount;
    return Math.round((remaining * avgTime) / 1000); // seconds
  }

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

  /**
   * Preprocess content (same as EmbeddingService)
   */
  private preprocessContent(content: string): string {
    // Strip frontmatter
    let processed = content.replace(/^---[\s\S]*?---\n?/, '');

    // Strip image embeds, keep link text
    processed = processed
      .replace(/!\[\[.*?\]\]/g, '')
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1');

    // Normalize whitespace
    processed = processed.replace(/\s+/g, ' ').trim();

    return processed;
  }

  /**
   * Hash content (same as EmbeddingService)
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i);
      hash = hash & hash;
    }
    return hash.toString(36);
  }

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

  // ==================== TRACE INDEXING ====================

  /**
   * Start indexing of all memory traces (backfill existing traces)
   * This is separate from note indexing and processes workspace traces
   */
  async startTraceIndex(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    if (!this.embeddingService.isServiceEnabled()) {
      return;
    }

    // Query all traces from the database
    const allTraces = await this.db.query<{
      id: string;
      workspaceId: string;
      sessionId: string | null;
      content: string;
    }>('SELECT id, workspaceId, sessionId, content FROM memory_traces');

    // Filter to traces not already embedded
    const needsIndexing: typeof allTraces = [];

    for (const trace of allTraces) {
      const existing = await this.db.queryOne<{ traceId: string }>(
        'SELECT traceId FROM trace_embedding_metadata WHERE traceId = ?',
        [trace.id]
      );
      if (!existing) {
        needsIndexing.push(trace);
      }
    }

    if (needsIndexing.length === 0) {
      return;
    }

    this.isRunning = true;
    this.totalCount = needsIndexing.length;
    this.processedCount = 0;
    this.startTime = Date.now();
    this.processingTimes = [];
    this.abortController = new AbortController();

    this.emitProgress({
      phase: 'indexing',
      totalNotes: this.totalCount,
      processedNotes: 0,
      currentNote: 'traces',
      estimatedTimeRemaining: null
    });

    try {
      for (const trace of needsIndexing) {
        if (this.abortController?.signal.aborted) {
          break;
        }

        if (this.isPaused) {
          await this.waitForResume();
          continue;
        }

        try {
          await this.embeddingService.embedTrace(
            trace.id,
            trace.workspaceId,
            trace.sessionId ?? undefined,
            trace.content
          );
          this.processedCount++;

          // Periodic DB save
          if (this.processedCount % this.SAVE_INTERVAL === 0) {
            await this.db.save();
          }

        } catch (error) {
          console.error(`[IndexingQueue] Failed to embed trace ${trace.id}:`, error);
        }

        // Yield to UI
        await new Promise(r => setTimeout(r, this.YIELD_INTERVAL_MS));
      }

      // Final save
      await this.db.save();

    } catch (error: any) {
      console.error('[IndexingQueue] Trace processing failed:', error);
    } finally {
      this.isRunning = false;
      this.emitProgress({
        phase: 'complete',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null
      });
    }
  }
}
