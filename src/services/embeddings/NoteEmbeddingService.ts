/**
 * Location: src/services/embeddings/NoteEmbeddingService.ts
 * Purpose: Domain service for note-level embedding operations.
 *
 * Handles embedding, searching, and managing embeddings for vault notes.
 * Each note gets a single embedding (no chunking) stored in the note_embeddings
 * vec0 table with metadata in embedding_metadata.
 *
 * Features:
 * - Note-level embeddings (one per note, no chunking)
 * - Content hash for change detection (skip re-embedding unchanged notes)
 * - Semantic search with heuristic re-ranking (recency + title match)
 * - Find similar notes by embedding distance
 * - Path updates for rename operations
 *
 * Relationships:
 * - Used by EmbeddingService (facade) which delegates note operations here
 * - Uses EmbeddingEngine for generating embeddings
 * - Uses SQLiteCacheManager for vector storage
 * - Uses shared utilities from EmbeddingUtils.ts
 */

import { App, TFile } from 'obsidian';
import type { EmbeddingEngine } from './EmbeddingEngine';
import { preprocessContent, hashContent } from './EmbeddingUtils';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';

export interface SimilarNote {
  notePath: string;
  distance: number;
}

export class NoteEmbeddingService {
  private app: App;
  private db: SQLiteCacheManager;
  private engine: EmbeddingEngine;

  constructor(app: App, db: SQLiteCacheManager, engine: EmbeddingEngine) {
    this.app = app;
    this.db = db;
    this.engine = engine;
  }

  /**
   * Embed a single note (or update if content changed)
   *
   * @param notePath - Path to the note
   */
  async embedNote(notePath: string): Promise<void> {
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
      const processedContent = preprocessContent(content);

      // Skip empty notes
      if (!processedContent) {
        return;
      }

      const contentHash = hashContent(processedContent);

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
      console.error(`[NoteEmbeddingService] Failed to embed note ${notePath}:`, error);
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
      console.error('[NoteEmbeddingService] Failed to find similar notes:', error);
      return [];
    }
  }

  /**
   * Semantic search for notes by query text.
   * Applies heuristic re-ranking (Recency + Title Match).
   *
   * @param query - Search query
   * @param limit - Maximum number of results (default: 10)
   * @returns Array of matching notes with distance scores
   */
  async semanticSearch(query: string, limit = 10): Promise<SimilarNote[]> {
    try {
      // Generate query embedding
      const queryEmbedding = await this.engine.generateEmbedding(query);
      const queryBuffer = Buffer.from(queryEmbedding.buffer);

      // 1. FETCH CANDIDATES
      // Fetch 3x the limit to allow for re-ranking
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
          originalDistance: item.distance
        };
      });

      // 3. SORT & SLICE
      ranked.sort((a, b) => a.distance - b.distance);

      return ranked.slice(0, limit);
    } catch (error) {
      console.error('[NoteEmbeddingService] Semantic search failed:', error);
      return [];
    }
  }

  /**
   * Remove embedding for a note
   *
   * @param notePath - Path to the note
   */
  async removeEmbedding(notePath: string): Promise<void> {
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
      console.error(`[NoteEmbeddingService] Failed to remove embedding for ${notePath}:`, error);
    }
  }

  /**
   * Update note path (for rename operations)
   *
   * @param oldPath - Old note path
   * @param newPath - New note path
   */
  async updatePath(oldPath: string, newPath: string): Promise<void> {
    try {
      await this.db.run(
        'UPDATE embedding_metadata SET notePath = ? WHERE notePath = ?',
        [newPath, oldPath]
      );
    } catch (error) {
      console.error(`[NoteEmbeddingService] Failed to update path ${oldPath} -> ${newPath}:`, error);
    }
  }

  /**
   * Get note embedding statistics
   *
   * @returns Count of embedded notes
   */
  async getNoteStats(): Promise<number> {
    try {
      const result = await this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM embedding_metadata'
      );
      return result?.count ?? 0;
    } catch (error) {
      console.error('[NoteEmbeddingService] Failed to get stats:', error);
      return 0;
    }
  }
}
