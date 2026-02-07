/**
 * Location: src/services/embeddings/TraceEmbeddingService.ts
 * Purpose: Domain service for memory trace embedding operations.
 *
 * Handles embedding, searching, and managing embeddings for workspace memory
 * traces. Each trace gets a single embedding stored in the trace_embeddings
 * vec0 table with metadata in trace_embedding_metadata.
 *
 * Features:
 * - Trace-level embeddings (one per memory trace)
 * - Content hash for change detection (skip re-embedding unchanged traces)
 * - Semantic search with recency re-ranking (20% max, 14-day linear decay)
 * - Workspace-scoped search filtering
 * - Bulk removal by workspace
 *
 * Relationships:
 * - Used by EmbeddingService (facade) which delegates trace operations here
 * - Uses EmbeddingEngine for generating embeddings
 * - Uses SQLiteCacheManager for vector storage
 * - Uses shared utilities from EmbeddingUtils.ts
 */

import type { EmbeddingEngine } from './EmbeddingEngine';
import { preprocessContent, hashContent } from './EmbeddingUtils';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';

export interface TraceSearchResult {
  traceId: string;
  workspaceId: string;
  sessionId: string | null;
  distance: number;
}

export class TraceEmbeddingService {
  private db: SQLiteCacheManager;
  private engine: EmbeddingEngine;

  constructor(db: SQLiteCacheManager, engine: EmbeddingEngine) {
    this.db = db;
    this.engine = engine;
  }

  /**
   * Embed a memory trace (called on trace creation)
   *
   * @param traceId - Unique trace ID
   * @param workspaceId - Workspace ID
   * @param sessionId - Session ID (optional)
   * @param content - Trace content to embed
   */
  async embedTrace(
    traceId: string,
    workspaceId: string,
    sessionId: string | undefined,
    content: string
  ): Promise<void> {
    try {
      const processedContent = preprocessContent(content);
      if (!processedContent) {
        return;
      }

      const contentHash = hashContent(processedContent);

      // Check if already exists
      const existing = await this.db.queryOne<{ rowid: number; contentHash: string }>(
        'SELECT rowid, contentHash FROM trace_embedding_metadata WHERE traceId = ?',
        [traceId]
      );

      if (existing && existing.contentHash === contentHash) {
        return; // Already current
      }

      // Generate embedding
      const embedding = await this.engine.generateEmbedding(processedContent);
      // Convert Float32Array to Buffer for SQLite BLOB binding
      const embeddingBuffer = Buffer.from(embedding.buffer);

      const now = Date.now();
      const modelInfo = this.engine.getModelInfo();

      // Insert or update
      if (existing) {
        // Update existing - vec0 tables need direct buffer
        await this.db.run(
          'UPDATE trace_embeddings SET embedding = ? WHERE rowid = ?',
          [embeddingBuffer, existing.rowid]
        );
        await this.db.run(
          'UPDATE trace_embedding_metadata SET contentHash = ?, model = ? WHERE rowid = ?',
          [contentHash, modelInfo.id, existing.rowid]
        );
      } else {
        // Insert new - vec0 auto-generates rowid
        await this.db.run(
          'INSERT INTO trace_embeddings(embedding) VALUES (?)',
          [embeddingBuffer]
        );
        const result = await this.db.queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
        const rowid = result?.id ?? 0;

        await this.db.run(
          `INSERT INTO trace_embedding_metadata(rowid, traceId, workspaceId, sessionId, model, contentHash, created)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [rowid, traceId, workspaceId, sessionId || null, modelInfo.id, contentHash, now]
        );
      }
    } catch (error) {
      console.error(`[TraceEmbeddingService] Failed to embed trace ${traceId}:`, error);
    }
  }

  /**
   * Semantic search for traces by query text.
   * Applies heuristic re-ranking (Recency).
   *
   * @param query - Search query
   * @param workspaceId - Filter by workspace
   * @param limit - Maximum number of results (default: 20)
   * @returns Array of matching traces with distance scores
   */
  async semanticTraceSearch(
    query: string,
    workspaceId: string,
    limit = 20
  ): Promise<TraceSearchResult[]> {
    try {
      // Generate query embedding
      const queryEmbedding = await this.engine.generateEmbedding(query);
      const queryBuffer = Buffer.from(queryEmbedding.buffer);

      // 1. FETCH CANDIDATES
      // Fetch 3x limit for re-ranking
      const candidateLimit = limit * 3;

      // Use vec_distance_l2 for KNN search with vec0 tables
      const candidates = await this.db.query<{
        traceId: string;
        workspaceId: string;
        sessionId: string | null;
        distance: number;
        created: number;
      }>(`
        SELECT
          tem.traceId,
          tem.workspaceId,
          tem.sessionId,
          tem.created,
          vec_distance_l2(te.embedding, ?) as distance
        FROM trace_embeddings te
        JOIN trace_embedding_metadata tem ON tem.rowid = te.rowid
        WHERE tem.workspaceId = ?
        ORDER BY distance
        LIMIT ?
      `, [queryBuffer, workspaceId, candidateLimit]);

      // 2. RE-RANKING LOGIC
      const now = Date.now();
      const oneDayMs = 1000 * 60 * 60 * 24;

      const ranked = candidates.map(item => {
        let score = item.distance;

        // Recency Boost for Traces
        // Traces are memories; recent ones are often more relevant context
        const daysOld = (now - item.created) / oneDayMs;

        if (daysOld < 14) { // Boost last 2 weeks
           // Linear decay: 0 days = 20% boost
           const recencyBoost = 0.20 * (1 - (daysOld / 14));
           score = score * (1 - recencyBoost);
        }

        return {
          traceId: item.traceId,
          workspaceId: item.workspaceId,
          sessionId: item.sessionId,
          distance: score
        };
      });

      // 3. SORT & SLICE
      ranked.sort((a, b) => a.distance - b.distance);

      return ranked.slice(0, limit);
    } catch (error) {
      console.error('[TraceEmbeddingService] Semantic trace search failed:', error);
      return [];
    }
  }

  /**
   * Remove trace embedding
   *
   * @param traceId - Trace ID
   */
  async removeTraceEmbedding(traceId: string): Promise<void> {
    try {
      const existing = await this.db.queryOne<{ rowid: number }>(
        'SELECT rowid FROM trace_embedding_metadata WHERE traceId = ?',
        [traceId]
      );

      if (existing) {
        await this.db.run('DELETE FROM trace_embeddings WHERE rowid = ?', [existing.rowid]);
        await this.db.run('DELETE FROM trace_embedding_metadata WHERE rowid = ?', [existing.rowid]);
      }
    } catch (error) {
      console.error(`[TraceEmbeddingService] Failed to remove trace embedding ${traceId}:`, error);
    }
  }

  /**
   * Remove all trace embeddings for a workspace
   *
   * @param workspaceId - Workspace ID
   * @returns Number of traces removed
   */
  async removeWorkspaceTraceEmbeddings(workspaceId: string): Promise<number> {
    try {
      const traces = await this.db.query<{ rowid: number }>(
        'SELECT rowid FROM trace_embedding_metadata WHERE workspaceId = ?',
        [workspaceId]
      );

      for (const trace of traces) {
        await this.db.run('DELETE FROM trace_embeddings WHERE rowid = ?', [trace.rowid]);
        await this.db.run('DELETE FROM trace_embedding_metadata WHERE rowid = ?', [trace.rowid]);
      }

      return traces.length;
    } catch (error) {
      console.error(`[TraceEmbeddingService] Failed to remove workspace traces ${workspaceId}:`, error);
      return 0;
    }
  }

  /**
   * Get trace embedding statistics
   *
   * @returns Count of embedded traces
   */
  async getTraceStats(): Promise<number> {
    try {
      const result = await this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM trace_embedding_metadata'
      );
      return result?.count ?? 0;
    } catch (error) {
      console.error('[TraceEmbeddingService] Failed to get stats:', error);
      return 0;
    }
  }
}
