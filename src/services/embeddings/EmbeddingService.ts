/**
 * Location: src/services/embeddings/EmbeddingService.ts
 * Purpose: Manage note and trace embeddings with sqlite-vec storage
 *
 * Features:
 * - Note-level embeddings (one per note, no chunking)
 * - Trace-level embeddings (one per memory trace)
 * - Content hash for change detection
 * - Content preprocessing (strip frontmatter, normalize whitespace)
 * - Desktop-only (disabled on mobile)
 *
 * Relationships:
 * - Uses EmbeddingEngine for generating embeddings
 * - Uses SQLiteCacheManager for vector storage
 * - Used by EmbeddingWatcher and IndexingQueue
 */

import { App, TFile, Notice, Platform } from 'obsidian';
import { EmbeddingEngine } from './EmbeddingEngine';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';

export interface SimilarNote {
  notePath: string;
  distance: number;
}

export interface TraceSearchResult {
  traceId: string;
  workspaceId: string;
  sessionId: string | null;
  distance: number;
}

/**
 * Embedding service for notes and traces
 *
 * Desktop-only - check Platform.isMobile before using
 */
export class EmbeddingService {
  private app: App;
  private db: SQLiteCacheManager;
  private engine: EmbeddingEngine;
  private isEnabled: boolean;

  constructor(
    app: App,
    db: SQLiteCacheManager,
    engine: EmbeddingEngine
  ) {
    this.app = app;
    this.db = db;
    this.engine = engine;

    // Disable on mobile entirely
    this.isEnabled = !Platform.isMobile;

    if (!this.isEnabled) {
      console.log('[EmbeddingService] Disabled on mobile platform');
    }
  }

  /**
   * Initialize the service (loads embedding model)
   */
  async initialize(): Promise<void> {
    if (!this.isEnabled) {
      console.log('[EmbeddingService] Skipping initialization on mobile');
      return;
    }

    try {
      await this.engine.initialize();
      console.log('[EmbeddingService] Initialized successfully');
    } catch (error) {
      console.error('[EmbeddingService] Initialization failed:', error);
      new Notice('Failed to load embedding model. Vector search will be unavailable.');
      this.isEnabled = false;
    }
  }

  // ==================== NOTE EMBEDDINGS ====================

  /**
   * Embed a single note (or update if content changed)
   *
   * @param notePath - Path to the note
   */
  async embedNote(notePath: string): Promise<void> {
    if (!this.isEnabled) return;

    try {
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (!file || !(file instanceof TFile)) {
        // File doesn't exist - remove stale embedding
        await this.removeEmbedding(notePath);
        return;
      }

      // Only process markdown files
      if (file.extension !== 'md') {
        return;
      }

      const content = await this.app.vault.read(file);
      const processedContent = this.preprocessContent(content);

      // Skip empty notes
      if (!processedContent) {
        console.log(`[EmbeddingService] Skipping empty note: ${notePath}`);
        return;
      }

      const contentHash = this.hashContent(processedContent);

      // Check if already up to date
      const existing = await this.db.queryOne<{ rowid: number; contentHash: string }>(
        'SELECT rowid, contentHash FROM embedding_metadata WHERE notePath = ?',
        [notePath]
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
        // Update existing - vec0 tables need direct buffer, no vec_f32() function
        await this.db.run(
          'UPDATE note_embeddings SET embedding = ? WHERE rowid = ?',
          [embeddingBuffer, existing.rowid]
        );
        await this.db.run(
          'UPDATE embedding_metadata SET contentHash = ?, updated = ?, model = ? WHERE rowid = ?',
          [contentHash, now, modelInfo.id, existing.rowid]
        );
      } else {
        // Insert new - vec0 auto-generates rowid, we get it after insert
        await this.db.run(
          'INSERT INTO note_embeddings(embedding) VALUES (?)',
          [embeddingBuffer]
        );
        const result = await this.db.queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
        const rowid = result?.id ?? 0;

        await this.db.run(
          `INSERT INTO embedding_metadata(rowid, notePath, model, contentHash, created, updated)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [rowid, notePath, modelInfo.id, contentHash, now, now]
        );
      }
    } catch (error) {
      console.error(`[EmbeddingService] Failed to embed note ${notePath}:`, error);
      throw error;
    }
  }

  /**
   * Find notes similar to a given note
   *
   * @param notePath - Path to the reference note
   * @param limit - Maximum number of results (default: 10)
   * @returns Array of similar notes with distance scores
   */
  async findSimilarNotes(notePath: string, limit = 10): Promise<SimilarNote[]> {
    if (!this.isEnabled) return [];

    try {
      // First get the embedding for the source note
      const sourceEmbed = await this.db.queryOne<{ embedding: Buffer }>(
        `SELECT ne.embedding FROM note_embeddings ne
         JOIN embedding_metadata em ON em.rowid = ne.rowid
         WHERE em.notePath = ?`,
        [notePath]
      );

      if (!sourceEmbed) {
        return [];
      }

      // Then find similar notes using vec_distance_l2
      const results = await this.db.query<SimilarNote>(`
        SELECT
          em.notePath,
          vec_distance_l2(ne.embedding, ?) as distance
        FROM note_embeddings ne
        JOIN embedding_metadata em ON em.rowid = ne.rowid
        WHERE em.notePath != ?
        ORDER BY distance
        LIMIT ?
      `, [sourceEmbed.embedding, notePath, limit]);

      return results;
    } catch (error) {
      console.error('[EmbeddingService] Failed to find similar notes:', error);
      return [];
    }
  }

  /**
   * Semantic search for notes by query text
   * Applies heuristic re-ranking (Recency + Title Match)
   *
   * @param query - Search query
   * @param limit - Maximum number of results (default: 10)
   * @returns Array of matching notes with distance scores
   */
  async semanticSearch(query: string, limit = 10): Promise<SimilarNote[]> {
    if (!this.isEnabled) return [];

    try {
      // Generate query embedding
      const queryEmbedding = await this.engine.generateEmbedding(query);
      const queryBuffer = Buffer.from(queryEmbedding.buffer);

      // 1. FETCH CANDIDATES
      // Fetch 3x the limit to allow for re-ranking
      // We also need the 'updated' timestamp for recency scoring
      const candidateLimit = limit * 3;
      
      const candidates = await this.db.query<{ notePath: string; distance: number; updated: number }>(`
        SELECT
          em.notePath,
          em.updated,
          vec_distance_l2(ne.embedding, ?) as distance
        FROM note_embeddings ne
        JOIN embedding_metadata em ON em.rowid = ne.rowid
        ORDER BY distance
        LIMIT ?
      `, [queryBuffer, candidateLimit]);

      // 2. RE-RANKING LOGIC
      const now = Date.now();
      const oneDayMs = 1000 * 60 * 60 * 24;
      const queryLower = query.toLowerCase();
      const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2);

      const ranked = candidates.map(item => {
        let score = item.distance;

        // --- A. Recency Boost ---
        // Boost notes modified in the last 30 days
        const daysSinceUpdate = (now - item.updated) / oneDayMs;
        if (daysSinceUpdate < 30) {
          // Linear decay: 0 days = 15% boost, 30 days = 0% boost
          const recencyBoost = 0.15 * (1 - (daysSinceUpdate / 30));
          score = score * (1 - recencyBoost);
        }

        // --- B. Title/Path Boost ---
        // If query terms appear in the file path, give a significant boost
        const pathLower = item.notePath.toLowerCase();
        
        // Exact filename match (strongest)
        if (pathLower.includes(queryLower)) {
          score = score * 0.8; // 20% boost
        } 
        // Partial term match
        else if (queryTerms.some(term => pathLower.includes(term))) {
          score = score * 0.9; // 10% boost
        }

        return {
          notePath: item.notePath,
          distance: score,
          originalDistance: item.distance // Keep for debugging if needed
        };
      });

      // 3. SORT & SLICE
      ranked.sort((a, b) => a.distance - b.distance);

      return ranked.slice(0, limit);
    } catch (error) {
      console.error('[EmbeddingService] Semantic search failed:', error);
      return [];
    }
  }

  /**
   * Remove embedding for a note
   *
   * @param notePath - Path to the note
   */
  async removeEmbedding(notePath: string): Promise<void> {
    if (!this.isEnabled) return;

    try {
      const existing = await this.db.queryOne<{ rowid: number }>(
        'SELECT rowid FROM embedding_metadata WHERE notePath = ?',
        [notePath]
      );

      if (existing) {
        await this.db.run('DELETE FROM note_embeddings WHERE rowid = ?', [existing.rowid]);
        await this.db.run('DELETE FROM embedding_metadata WHERE rowid = ?', [existing.rowid]);
      }
    } catch (error) {
      console.error(`[EmbeddingService] Failed to remove embedding for ${notePath}:`, error);
    }
  }

  /**
   * Update note path (for rename operations)
   *
   * @param oldPath - Old note path
   * @param newPath - New note path
   */
  async updatePath(oldPath: string, newPath: string): Promise<void> {
    if (!this.isEnabled) return;

    try {
      await this.db.run(
        'UPDATE embedding_metadata SET notePath = ? WHERE notePath = ?',
        [newPath, oldPath]
      );
    } catch (error) {
      console.error(`[EmbeddingService] Failed to update path ${oldPath} -> ${newPath}:`, error);
    }
  }

  // ==================== TRACE EMBEDDINGS ====================

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
    if (!this.isEnabled) return;

    try {
      const processedContent = this.preprocessContent(content);
      if (!processedContent) {
        console.log(`[EmbeddingService] Skipping empty trace: ${traceId}`);
        return;
      }

      const contentHash = this.hashContent(processedContent);

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
      console.error(`[EmbeddingService] Failed to embed trace ${traceId}:`, error);
    }
  }

  /**
   * Semantic search for traces by query text
   * Applies heuristic re-ranking (Recency)
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
    if (!this.isEnabled) return [];

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
      console.error('[EmbeddingService] Semantic trace search failed:', error);
      return [];
    }
  }

  /**
   * Remove trace embedding
   *
   * @param traceId - Trace ID
   */
  async removeTraceEmbedding(traceId: string): Promise<void> {
    if (!this.isEnabled) return;

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
      console.error(`[EmbeddingService] Failed to remove trace embedding ${traceId}:`, error);
    }
  }

  /**
   * Remove all trace embeddings for a workspace
   *
   * @param workspaceId - Workspace ID
   * @returns Number of traces removed
   */
  async removeWorkspaceTraceEmbeddings(workspaceId: string): Promise<number> {
    if (!this.isEnabled) return 0;

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
      console.error(`[EmbeddingService] Failed to remove workspace traces ${workspaceId}:`, error);
      return 0;
    }
  }

  // ==================== UTILITIES ====================

  /**
   * Preprocess content before embedding
   * - Strips frontmatter
   * - Removes image embeds
   * - Normalizes whitespace
   * - Truncates if too long
   *
   * @param content - Raw content
   * @returns Processed content or null if empty
   */
  private preprocessContent(content: string): string | null {
    // Strip frontmatter
    let processed = content.replace(/^---[\s\S]*?---\n?/, '');

    // Strip image embeds, keep link text
    processed = processed
      .replace(/!\[\[.*?\]\]/g, '')                           // Obsidian image embeds
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')          // [[path|alias]] → alias
      .replace(/\[\[([^\]]+)\]\]/g, '$1');                    // [[path]] → path

    // Normalize whitespace
    processed = processed.replace(/\s+/g, ' ').trim();

    // Skip if too short
    if (processed.length < 10) {
      return null;
    }

    // Truncate if too long (model context limit)
    const MAX_CHARS = 2000;
    return processed.length > MAX_CHARS
      ? processed.slice(0, MAX_CHARS)
      : processed;
  }

  /**
   * Hash content for change detection
   *
   * @param content - Content to hash
   * @returns Hash string
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  /**
   * Check if service is enabled
   */
  isServiceEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Get embedding statistics
   */
  async getStats(): Promise<{
    noteCount: number;
    traceCount: number;
  }> {
    if (!this.isEnabled) {
      return { noteCount: 0, traceCount: 0 };
    }

    try {
      const noteResult = await this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM embedding_metadata'
      );
      const traceResult = await this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM trace_embedding_metadata'
      );

      return {
        noteCount: noteResult?.count ?? 0,
        traceCount: traceResult?.count ?? 0
      };
    } catch (error) {
      console.error('[EmbeddingService] Failed to get stats:', error);
      return { noteCount: 0, traceCount: 0 };
    }
  }
}
