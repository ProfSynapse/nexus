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
      console.warn('[IndexingQueue] Already running');
      return;
    }

    console.log('[IndexingQueue] ========================================');
    console.log('[IndexingQueue] Starting full index check...');

    if (!this.embeddingService.isServiceEnabled()) {
      console.log('[IndexingQueue] Embedding service not enabled, skipping indexing');
      console.log('[IndexingQueue] ========================================');
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
    console.log(`[IndexingQueue] Found ${allNotes.length} markdown files in vault`);

    // Filter to notes not already indexed (or with changed content)
    const filterStart = performance.now();
    const needsIndexing = await this.filterUnindexedNotes(allNotes);
    const filterTime = (performance.now() - filterStart).toFixed(0);

    const alreadyIndexed = allNotes.length - needsIndexing.length;
    console.log(`[IndexingQueue] Filtering complete (${filterTime}ms)`);
    console.log(`[IndexingQueue]   Already indexed: ${alreadyIndexed} notes`);
    console.log(`[IndexingQueue]   Needs indexing: ${needsIndexing.length} notes`);

    if (needsIndexing.length === 0) {
      console.log('[IndexingQueue] All notes are up to date');
      console.log('[IndexingQueue] ========================================');
      this.emitProgress({
        phase: 'complete',
        totalNotes: 0,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null
      });
      return;
    }

    console.log('[IndexingQueue] ----------------------------------------');
    console.log(`[IndexingQueue] Beginning indexing of ${needsIndexing.length} notes`);
    console.log(`[IndexingQueue] Settings: batchSize=${this.BATCH_SIZE}, yieldMs=${this.YIELD_INTERVAL_MS}, saveEvery=${this.SAVE_INTERVAL}`);

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
      } catch (error) {
        console.error(`[IndexingQueue] Error checking ${note.path}:`, error);
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
      console.log('[IndexingQueue] Phase 1: Loading embedding model...');
      const modelStart = performance.now();
      await this.embeddingService.initialize();
      const modelTime = (performance.now() - modelStart).toFixed(0);
      console.log(`[IndexingQueue] Model loaded (${modelTime}ms)`);

      this.emitProgress({
        phase: 'indexing',
        totalNotes: this.totalCount,
        processedNotes: 0,
        currentNote: null,
        estimatedTimeRemaining: null
      });

      console.log('[IndexingQueue] Phase 2: Processing notes...');
      let lastMilestone = 0;
      const milestoneInterval = Math.max(1, Math.floor(this.totalCount / 10)); // Log every ~10%

      while (this.queue.length > 0) {
        // Check for abort/pause
        if (this.abortController?.signal.aborted) {
          console.log('[IndexingQueue] Indexing cancelled');
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

          // Log progress milestones
          const currentMilestone = Math.floor(this.processedCount / milestoneInterval);
          if (currentMilestone > lastMilestone) {
            lastMilestone = currentMilestone;
            const percent = Math.round((this.processedCount / this.totalCount) * 100);
            const avgMs = this.processingTimes.length > 0
              ? Math.round(this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length)
              : 0;
            const eta = this.calculateETA();
            const etaStr = eta ? `${eta}s remaining` : 'calculating...';
            console.log(`[IndexingQueue] Progress: ${this.processedCount}/${this.totalCount} (${percent}%) - avg ${avgMs}ms/note - ${etaStr}`);
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

      // Calculate and log final statistics
      const totalTime = Date.now() - this.startTime;
      const totalSeconds = Math.round(totalTime / 1000);
      const avgMs = this.processingTimes.length > 0
        ? Math.round(this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length)
        : 0;
      const notesPerSecond = totalTime > 0 ? ((this.processedCount / totalTime) * 1000).toFixed(1) : '0';

      console.log('[IndexingQueue] ----------------------------------------');
      console.log('[IndexingQueue] Indexing complete!');
      console.log(`[IndexingQueue]   Notes processed: ${this.processedCount}/${this.totalCount}`);
      console.log(`[IndexingQueue]   Total time: ${totalSeconds}s`);
      console.log(`[IndexingQueue]   Average: ${avgMs}ms/note (${notesPerSecond} notes/sec)`);
      console.log('[IndexingQueue] ========================================');

      this.emitProgress({
        phase: 'complete',
        totalNotes: this.totalCount,
        processedNotes: this.processedCount,
        currentNote: null,
        estimatedTimeRemaining: null
      });

    } catch (error: any) {
      console.error('[IndexingQueue] ========================================');
      console.error('[IndexingQueue] Processing failed:', error);
      console.error('[IndexingQueue] ========================================');
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
    console.log('[IndexingQueue] Paused');
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
    console.log('[IndexingQueue] Resumed');
  }

  /**
   * Cancel indexing entirely
   */
  cancel(): void {
    if (!this.isRunning) return;

    console.log('[IndexingQueue] Cancelled');
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
      console.warn('[IndexingQueue] Note indexing in progress, will run trace indexing after');
      return;
    }

    console.log('[IndexingQueue] ========================================');
    console.log('[IndexingQueue] Starting trace backfill...');

    if (!this.embeddingService.isServiceEnabled()) {
      console.log('[IndexingQueue] Embedding service not enabled, skipping trace indexing');
      console.log('[IndexingQueue] ========================================');
      return;
    }

    // Query all traces from the database
    const allTraces = await this.db.query<{
      id: string;
      workspaceId: string;
      sessionId: string | null;
      content: string;
    }>('SELECT id, workspaceId, sessionId, content FROM memory_traces');

    console.log(`[IndexingQueue] Found ${allTraces.length} traces in database`);

    // Filter to traces not already embedded
    const filterStart = performance.now();
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

    const filterTime = (performance.now() - filterStart).toFixed(0);
    const alreadyIndexed = allTraces.length - needsIndexing.length;
    console.log(`[IndexingQueue] Filtering complete (${filterTime}ms)`);
    console.log(`[IndexingQueue]   Already indexed: ${alreadyIndexed} traces`);
    console.log(`[IndexingQueue]   Needs indexing: ${needsIndexing.length} traces`);

    if (needsIndexing.length === 0) {
      console.log('[IndexingQueue] All traces are up to date');
      console.log('[IndexingQueue] ========================================');
      return;
    }

    console.log('[IndexingQueue] ----------------------------------------');
    console.log(`[IndexingQueue] Beginning trace indexing (${needsIndexing.length} traces)`);

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
      let lastMilestone = 0;
      const milestoneInterval = Math.max(1, Math.floor(this.totalCount / 10));

      for (const trace of needsIndexing) {
        if (this.abortController?.signal.aborted) {
          console.log('[IndexingQueue] Trace indexing cancelled');
          break;
        }

        if (this.isPaused) {
          await this.waitForResume();
          continue;
        }

        const traceStart = Date.now();

        try {
          await this.embeddingService.embedTrace(
            trace.id,
            trace.workspaceId,
            trace.sessionId ?? undefined,
            trace.content
          );
          this.processedCount++;

          // Track timing for ETA
          const elapsed = Date.now() - traceStart;
          this.processingTimes.push(elapsed);
          if (this.processingTimes.length > 20) {
            this.processingTimes.shift();
          }

          // Log progress milestones
          const currentMilestone = Math.floor(this.processedCount / milestoneInterval);
          if (currentMilestone > lastMilestone) {
            lastMilestone = currentMilestone;
            const percent = Math.round((this.processedCount / this.totalCount) * 100);
            console.log(`[IndexingQueue] Trace progress: ${this.processedCount}/${this.totalCount} (${percent}%)`);
          }

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

      const totalTime = Date.now() - this.startTime;
      const totalSeconds = Math.round(totalTime / 1000);
      console.log('[IndexingQueue] ----------------------------------------');
      console.log('[IndexingQueue] Trace indexing complete!');
      console.log(`[IndexingQueue]   Traces processed: ${this.processedCount}/${this.totalCount}`);
      console.log(`[IndexingQueue]   Total time: ${totalSeconds}s`);
      console.log('[IndexingQueue] ========================================');

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
