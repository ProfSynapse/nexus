/**
 * Location: src/services/embeddings/EmbeddingService.ts
 * Purpose: Manage note, trace, and conversation embeddings with sqlite-vec storage
 *
 * Features:
 * - Note-level embeddings (one per note, no chunking)
 * - Trace-level embeddings (one per memory trace)
 * - Conversation QA pair embeddings (chunked Q and A with multi-signal reranking)
 * - Content hash for change detection
 * - Content preprocessing (strip frontmatter, normalize whitespace)
 * - Desktop-only (disabled on mobile)
 *
 * Relationships:
 * - Uses EmbeddingEngine for generating embeddings
 * - Uses SQLiteCacheManager for vector storage
 * - Used by EmbeddingWatcher, IndexingQueue, and ConversationEmbeddingWatcher
 * - Uses ContentChunker for splitting conversation content into overlapping chunks
 * - Uses QAPair type from QAPairBuilder
 */

import { App, TFile, Notice, Platform } from 'obsidian';
import { EmbeddingEngine } from './EmbeddingEngine';
import { chunkContent } from './ContentChunker';
import type { QAPair } from './QAPairBuilder';
import type { MessageData } from '../../types/storage/HybridStorageTypes';
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
 * Result from semantic conversation search.
 *
 * Contains the full Q and A text for the matched pair, plus metadata about
 * the match quality and location within the conversation. The optional
 * windowMessages field is populated by the caller (scoped search mode)
 * using ConversationWindowRetriever.
 */
export interface ConversationSearchResult {
  /** Conversation containing the matched pair */
  conversationId: string;
  /** Title of the conversation for display */
  conversationTitle: string;
  /** Session the conversation belongs to (if any) */
  sessionId?: string;
  /** Workspace the conversation belongs to (if any) */
  workspaceId?: string;
  /** Unique QA pair identifier */
  pairId: string;
  /** Sequence number range [start, end] of the matched pair */
  matchedSequenceRange: [number, number];
  /** Full user message text */
  question: string;
  /** Full assistant response text */
  answer: string;
  /** Which side of the pair matched the query */
  matchedSide: 'question' | 'answer';
  /** Raw L2 distance from vec0 KNN search (lower = more similar) */
  distance: number;
  /** Reranked score after applying recency, density, and reference boosts (lower = better) */
  score: number;
  /** Whether this is a conversation turn or tool trace pair */
  pairType: 'conversation_turn' | 'trace_pair';
  /** Optional windowed messages for scoped retrieval (populated by caller) */
  windowMessages?: MessageData[];
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
  }

  /**
   * Initialize the service (loads embedding model)
   */
  async initialize(): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    try {
      await this.engine.initialize();
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

  // ==================== CONVERSATION EMBEDDINGS ====================

  /**
   * Embed a conversation QA pair by chunking Q and A independently.
   *
   * Each chunk gets its own embedding vector in the conversation_embeddings vec0
   * table, with metadata in conversation_embedding_metadata linking back to the
   * original pairId. Uses contentHash for idempotency -- if the pair has already
   * been embedded with the same content, this is a no-op.
   *
   * @param qaPair - A QA pair from QAPairBuilder (conversation turn or trace pair)
   */
  async embedConversationTurn(qaPair: QAPair): Promise<void> {
    if (!this.isEnabled) return;

    try {
      // Idempotency: check if any chunk for this pairId already has the same contentHash
      const existing = await this.db.queryOne<{ contentHash: string }>(
        'SELECT contentHash FROM conversation_embedding_metadata WHERE pairId = ? LIMIT 1',
        [qaPair.pairId]
      );

      if (existing && existing.contentHash === qaPair.contentHash) {
        return; // Already embedded with same content
      }

      // If content changed, remove old embeddings before re-embedding
      if (existing) {
        await this.removeConversationPairEmbeddings(qaPair.pairId);
      }

      const modelInfo = this.engine.getModelInfo();
      const now = Date.now();

      // Chunk and embed each side independently
      const sides: Array<{ side: 'question' | 'answer'; text: string }> = [
        { side: 'question', text: qaPair.question },
        { side: 'answer', text: qaPair.answer },
      ];

      for (const { side, text } of sides) {
        if (!text || text.trim().length === 0) {
          continue;
        }

        const chunks = chunkContent(text);

        for (const chunk of chunks) {
          // Generate embedding for this chunk
          const embedding = await this.engine.generateEmbedding(chunk.text);
          const embeddingBuffer = Buffer.from(embedding.buffer);

          // Insert into vec0 table
          await this.db.run(
            'INSERT INTO conversation_embeddings(embedding) VALUES (?)',
            [embeddingBuffer]
          );
          const result = await this.db.queryOne<{ id: number }>(
            'SELECT last_insert_rowid() as id'
          );
          const rowid = result?.id ?? 0;

          // Insert metadata
          const contentPreview = chunk.text.slice(0, 200);
          await this.db.run(
            `INSERT INTO conversation_embedding_metadata(
              rowid, pairId, side, chunkIndex, conversationId,
              startSequenceNumber, endSequenceNumber, pairType,
              sourceId, sessionId, workspaceId, model,
              contentHash, contentPreview, created
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              rowid,
              qaPair.pairId,
              side,
              chunk.chunkIndex,
              qaPair.conversationId,
              qaPair.startSequenceNumber,
              qaPair.endSequenceNumber,
              qaPair.pairType,
              qaPair.sourceId,
              qaPair.sessionId || null,
              qaPair.workspaceId || null,
              modelInfo.id,
              qaPair.contentHash,
              contentPreview,
              now,
            ]
          );
        }
      }
    } catch (error) {
      console.error(
        `[EmbeddingService] Failed to embed conversation turn ${qaPair.pairId}:`,
        error
      );
    }
  }

  /**
   * Semantic search across conversation embeddings with multi-signal reranking.
   *
   * Search flow:
   * 1. Generate query embedding and perform KNN search in vec0 table
   * 2. Filter by workspaceId (required) and optionally sessionId
   * 3. Deduplicate by pairId (keep best-matching chunk per pair)
   * 4. Apply multi-signal reranking:
   *    a. Recency boost (20% max, 14-day linear decay)
   *    b. Session density boost (15% max, rewards clusters of related results)
   *    c. Note reference boost (10%, rewards wiki-link matches to query terms)
   * 5. Fetch full Q and A text from messages table for each result
   *
   * @param query - Search query text
   * @param workspaceId - Required workspace filter
   * @param sessionId - Optional session filter for narrower scope
   * @param limit - Maximum results to return (default: 20)
   * @returns Array of ConversationSearchResult sorted by score ascending (lower = better)
   */
  async semanticConversationSearch(
    query: string,
    workspaceId: string,
    sessionId?: string,
    limit = 20
  ): Promise<ConversationSearchResult[]> {
    if (!this.isEnabled) return [];

    try {
      // Generate query embedding
      const queryEmbedding = await this.engine.generateEmbedding(query);
      const queryBuffer = Buffer.from(queryEmbedding.buffer);

      // 1. FETCH CANDIDATES
      // Fetch limit * 3 for reranking headroom
      const candidateLimit = limit * 3;

      const candidates = await this.db.query<{
        pairId: string;
        side: string;
        conversationId: string;
        startSequenceNumber: number;
        endSequenceNumber: number;
        pairType: string;
        sessionId: string | null;
        workspaceId: string | null;
        contentPreview: string | null;
        distance: number;
        created: number;
      }>(`
        SELECT
          cem.pairId,
          cem.side,
          cem.conversationId,
          cem.startSequenceNumber,
          cem.endSequenceNumber,
          cem.pairType,
          cem.sessionId,
          cem.workspaceId,
          cem.contentPreview,
          cem.created,
          vec_distance_l2(ce.embedding, ?) as distance
        FROM conversation_embeddings ce
        JOIN conversation_embedding_metadata cem ON cem.rowid = ce.rowid
        WHERE cem.workspaceId = ?
        ORDER BY distance
        LIMIT ?
      `, [queryBuffer, workspaceId, candidateLimit]);

      // Apply sessionId filter in application layer
      // (sqlite-vec does not support WHERE pushdown on vec0 tables)
      const filtered = sessionId
        ? candidates.filter(c => c.sessionId === sessionId)
        : candidates;

      // 2. DEDUPLICATE BY pairId
      // Keep the chunk with the lowest distance per pair
      const bestByPair = new Map<string, typeof filtered[number]>();
      for (const candidate of filtered) {
        const existing = bestByPair.get(candidate.pairId);
        if (!existing || candidate.distance < existing.distance) {
          bestByPair.set(candidate.pairId, candidate);
        }
      }
      const deduplicated = Array.from(bestByPair.values());

      // 3. RE-RANKING LOGIC
      const now = Date.now();
      const oneDayMs = 1000 * 60 * 60 * 24;
      const queryLower = query.toLowerCase();
      const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2);

      // Pre-compute session density counts for the density boost
      const sessionHitCounts = new Map<string, number>();
      for (const item of deduplicated) {
        if (item.sessionId) {
          sessionHitCounts.set(
            item.sessionId,
            (sessionHitCounts.get(item.sessionId) ?? 0) + 1
          );
        }
      }

      // Look up conversation timestamps for recency scoring
      const conversationIds = [...new Set(deduplicated.map(d => d.conversationId))];
      const conversationCreatedMap = new Map<string, number>();
      for (const convId of conversationIds) {
        const conv = await this.db.queryOne<{ created: number }>(
          'SELECT created FROM conversations WHERE id = ?',
          [convId]
        );
        if (conv) {
          conversationCreatedMap.set(convId, conv.created);
        }
      }

      const ranked = deduplicated.map(item => {
        let score = item.distance;

        // --- A. Recency Boost (20% max, 14-day linear decay) ---
        const convCreated = conversationCreatedMap.get(item.conversationId) ?? item.created;
        const daysSince = (now - convCreated) / oneDayMs;
        if (daysSince < 14) {
          score = score * (1 - 0.20 * Math.max(0, 1 - daysSince / 14));
        }

        // --- B. Session Density Boost (15% max) ---
        if (item.sessionId) {
          const hitCount = sessionHitCounts.get(item.sessionId) ?? 0;
          if (hitCount >= 2) {
            score = score * (1 - 0.15 * Math.min(1, (hitCount - 1) / 3));
          }
        }

        // --- C. Note Reference Boost (10%) ---
        // Check if content preview contains [[wiki-links]] matching query terms
        if (item.contentPreview && queryTerms.length > 0) {
          const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;
          const previewLower = item.contentPreview.toLowerCase();
          let match: RegExpExecArray | null;
          let hasMatchingRef = false;

          while ((match = wikiLinkPattern.exec(previewLower)) !== null) {
            const linkText = match[1];
            if (queryTerms.some(term => linkText.includes(term))) {
              hasMatchingRef = true;
              break;
            }
          }

          if (hasMatchingRef) {
            score = score * 0.9; // 10% boost
          }
        }

        return {
          ...item,
          score,
          matchedSide: item.side as 'question' | 'answer',
        };
      });

      // 4. SORT & SLICE
      ranked.sort((a, b) => a.score - b.score);
      const topResults = ranked.slice(0, limit);

      // 5. FETCH FULL Q AND A TEXT
      // Use sequence range to find original user + assistant messages
      const results: ConversationSearchResult[] = [];

      for (const item of topResults) {
        // Fetch conversation title
        const conv = await this.db.queryOne<{ title: string }>(
          'SELECT title FROM conversations WHERE id = ?',
          [item.conversationId]
        );
        const conversationTitle = conv?.title ?? 'Untitled';

        // Fetch messages in the sequence range to get full Q and A
        const messages = await this.db.query<{
          role: string;
          content: string | null;
        }>(
          `SELECT role, content FROM messages
           WHERE conversationId = ?
             AND sequenceNumber >= ?
             AND sequenceNumber <= ?
           ORDER BY sequenceNumber ASC`,
          [item.conversationId, item.startSequenceNumber, item.endSequenceNumber]
        );

        // Extract Q (first user message) and A (first assistant message)
        let question = '';
        let answer = '';
        for (const msg of messages) {
          if (msg.role === 'user' && !question) {
            question = msg.content ?? '';
          } else if (msg.role === 'assistant' && !answer) {
            answer = msg.content ?? '';
          }
        }

        results.push({
          conversationId: item.conversationId,
          conversationTitle,
          sessionId: item.sessionId ?? undefined,
          workspaceId: item.workspaceId ?? undefined,
          pairId: item.pairId,
          matchedSequenceRange: [item.startSequenceNumber, item.endSequenceNumber],
          question,
          answer,
          matchedSide: item.matchedSide,
          distance: item.distance,
          score: item.score,
          pairType: item.pairType as 'conversation_turn' | 'trace_pair',
        });
      }

      return results;
    } catch (error) {
      console.error('[EmbeddingService] Semantic conversation search failed:', error);
      return [];
    }
  }

  /**
   * Remove all embeddings for a conversation.
   *
   * Deletes from both the vec0 table and the metadata table. Used when a
   * conversation is deleted or needs full re-indexing.
   *
   * @param conversationId - The conversation whose embeddings should be removed
   */
  async removeConversationEmbeddings(conversationId: string): Promise<void> {
    if (!this.isEnabled) return;

    try {
      const rows = await this.db.query<{ rowid: number }>(
        'SELECT rowid FROM conversation_embedding_metadata WHERE conversationId = ?',
        [conversationId]
      );

      for (const row of rows) {
        await this.db.run('DELETE FROM conversation_embeddings WHERE rowid = ?', [row.rowid]);
        await this.db.run('DELETE FROM conversation_embedding_metadata WHERE rowid = ?', [row.rowid]);
      }
    } catch (error) {
      console.error(
        `[EmbeddingService] Failed to remove conversation embeddings for ${conversationId}:`,
        error
      );
    }
  }

  /**
   * Remove all embeddings for a single QA pair.
   *
   * Used internally when re-embedding a pair whose content has changed.
   *
   * @param pairId - The QA pair whose embeddings should be removed
   */
  private async removeConversationPairEmbeddings(pairId: string): Promise<void> {
    const rows = await this.db.query<{ rowid: number }>(
      'SELECT rowid FROM conversation_embedding_metadata WHERE pairId = ?',
      [pairId]
    );

    for (const row of rows) {
      await this.db.run('DELETE FROM conversation_embeddings WHERE rowid = ?', [row.rowid]);
      await this.db.run('DELETE FROM conversation_embedding_metadata WHERE rowid = ?', [row.rowid]);
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
    conversationChunkCount: number;
  }> {
    if (!this.isEnabled) {
      return { noteCount: 0, traceCount: 0, conversationChunkCount: 0 };
    }

    try {
      const noteResult = await this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM embedding_metadata'
      );
      const traceResult = await this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM trace_embedding_metadata'
      );
      const convResult = await this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM conversation_embedding_metadata'
      );

      return {
        noteCount: noteResult?.count ?? 0,
        traceCount: traceResult?.count ?? 0,
        conversationChunkCount: convResult?.count ?? 0
      };
    } catch (error) {
      console.error('[EmbeddingService] Failed to get stats:', error);
      return { noteCount: 0, traceCount: 0, conversationChunkCount: 0 };
    }
  }
}
