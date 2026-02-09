/**
 * Trace Indexer
 *
 * Location: src/services/embeddings/TraceIndexer.ts
 * Purpose: Backfill embeddings for existing memory traces. Processes all traces
 *          that do not yet have an embedding vector and yields to the UI thread
 *          between items to keep Obsidian responsive.
 * Used by: IndexingQueue delegates trace backfill here.
 *
 * Relationships:
 *   - Uses EmbeddingService for embedding trace content
 *   - Uses SQLiteCacheManager for querying un-embedded traces and periodic saves
 */

import { EmbeddingService } from './EmbeddingService';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';

/**
 * Progress callback signature emitted by the indexer to the owning queue.
 */
export interface TraceIndexerProgress {
  totalTraces: number;
  processedTraces: number;
}

/**
 * Handles backfill indexing for existing memory traces.
 *
 * Queries all traces from the database, filters out those already embedded,
 * then processes each one. Embedding is idempotent -- re-running is safe.
 */
export class TraceIndexer {
  private db: SQLiteCacheManager;
  private embeddingService: EmbeddingService;
  private onProgress: (progress: TraceIndexerProgress) => void;
  private saveInterval: number;
  private yieldIntervalMs: number;

  private isRunning = false;

  constructor(
    db: SQLiteCacheManager,
    embeddingService: EmbeddingService,
    onProgress: (progress: TraceIndexerProgress) => void,
    saveInterval: number = 10,
    yieldIntervalMs: number = 50
  ) {
    this.db = db;
    this.embeddingService = embeddingService;
    this.onProgress = onProgress;
    this.saveInterval = saveInterval;
    this.yieldIntervalMs = yieldIntervalMs;
  }

  /**
   * Whether trace indexing is currently running.
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Start trace backfill.
   *
   * @param abortSignal - Signal from the parent queue for cancellation
   * @param isPaused - Callback to check whether the parent queue is paused
   * @param waitForResume - Callback to await until the parent queue resumes
   * @returns Total and processed counts when finished
   */
  async start(
    abortSignal: AbortSignal | null,
    isPaused: () => boolean,
    waitForResume: () => Promise<void>
  ): Promise<{ total: number; processed: number }> {
    if (this.isRunning) {
      return { total: 0, processed: 0 };
    }

    if (!this.embeddingService.isServiceEnabled()) {
      return { total: 0, processed: 0 };
    }

    // Query all traces from the database
    const allTraces = await this.db.query<{
      id: string;
      workspaceId: string;
      sessionId: string | null;
      content: string;
    }>('SELECT id, workspaceId, sessionId, content FROM memory_traces');

    // Get all already-embedded trace IDs in a single query (avoids N+1)
    const embeddedRows = await this.db.query<{ traceId: string }>(
      'SELECT DISTINCT traceId FROM trace_embedding_metadata'
    );
    const embeddedIds = new Set(embeddedRows.map(r => r.traceId));

    // Filter to traces not already embedded
    const needsIndexing = allTraces.filter(t => !embeddedIds.has(t.id));

    if (needsIndexing.length === 0) {
      return { total: 0, processed: 0 };
    }

    this.isRunning = true;
    let processedCount = 0;
    const totalCount = needsIndexing.length;

    this.onProgress({ totalTraces: totalCount, processedTraces: 0 });

    try {
      for (const trace of needsIndexing) {
        if (abortSignal?.aborted) {
          break;
        }

        if (isPaused()) {
          await waitForResume();
          continue;
        }

        try {
          await this.embeddingService.embedTrace(
            trace.id,
            trace.workspaceId,
            trace.sessionId ?? undefined,
            trace.content
          );
          processedCount++;

          if (processedCount % this.saveInterval === 0) {
            await this.db.save();
          }

        } catch (error) {
          console.error(`[TraceIndexer] Failed to embed trace ${trace.id}:`, error);
        }

        // Yield to UI
        await new Promise(r => setTimeout(r, this.yieldIntervalMs));
      }

      // Final save
      await this.db.save();

    } catch (error: unknown) {
      console.error('[TraceIndexer] Trace processing failed:', error);
    } finally {
      this.isRunning = false;
      this.onProgress({ totalTraces: totalCount, processedTraces: processedCount });
    }

    return { total: totalCount, processed: processedCount };
  }
}
