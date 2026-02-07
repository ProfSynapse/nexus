/**
 * Location: src/services/embeddings/ConversationEmbeddingService.ts
 * Purpose: Domain service for conversation QA pair embedding operations.
 *
 * Handles embedding, searching, and managing embeddings for conversation turns.
 * Each QA pair is chunked (Q and A independently) and stored in the
 * conversation_embeddings vec0 table with metadata in
 * conversation_embedding_metadata.
 *
 * Features:
 * - QA pair embeddings with independent Q/A chunking
 * - Content hash for idempotency (skip re-embedding unchanged pairs)
 * - Semantic search with multi-signal reranking:
 *   a. Recency boost (20% max, 14-day linear decay)
 *   b. Session density boost (15% max, rewards clusters of related results)
 *   c. Note reference boost (10%, rewards wiki-link matches to query terms)
 * - Deduplication by pairId (keep best-matching chunk per pair)
 * - Full Q and A text retrieval from messages table
 *
 * Relationships:
 * - Used by EmbeddingService (facade) which delegates conversation operations here
 * - Uses EmbeddingEngine for generating embeddings
 * - Uses SQLiteCacheManager for vector storage
 * - Uses ContentChunker for splitting conversation content into overlapping chunks
 * - Uses QAPair type from QAPairBuilder
 * - Uses extractWikiLinks from EmbeddingUtils for reference boosting
 */

import type { EmbeddingEngine } from './EmbeddingEngine';
import { chunkContent } from './ContentChunker';
import { extractWikiLinks } from './EmbeddingUtils';
import type { QAPair } from './QAPairBuilder';
import type { MessageData } from '../../types/storage/HybridStorageTypes';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';

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

export class ConversationEmbeddingService {
  private db: SQLiteCacheManager;
  private engine: EmbeddingEngine;

  constructor(db: SQLiteCacheManager, engine: EmbeddingEngine) {
    this.db = db;
    this.engine = engine;
  }

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

          // Extract wiki-links from the full chunk text for reference boosting
          const wikiLinks = extractWikiLinks(chunk.text);
          const referencedNotes = wikiLinks.length > 0 ? JSON.stringify(wikiLinks) : null;

          // Insert metadata
          const contentPreview = chunk.text.slice(0, 200);
          await this.db.run(
            `INSERT INTO conversation_embedding_metadata(
              rowid, pairId, side, chunkIndex, conversationId,
              startSequenceNumber, endSequenceNumber, pairType,
              sourceId, sessionId, workspaceId, model,
              contentHash, contentPreview, referencedNotes, created
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              referencedNotes,
              now,
            ]
          );
        }
      }
    } catch (error) {
      console.error(
        `[ConversationEmbeddingService] Failed to embed conversation turn ${qaPair.pairId}:`,
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
        referencedNotes: string | null;
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
          cem.referencedNotes,
          cem.created,
          vec_distance_l2(ce.embedding, ?) as distance
        FROM conversation_embeddings ce
        JOIN conversation_embedding_metadata cem ON cem.rowid = ce.rowid
        WHERE (cem.workspaceId = ? OR cem.workspaceId IS NULL)
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

      // Batch look up conversation timestamps for recency scoring (avoids N+1 queries)
      const conversationIds = [...new Set(deduplicated.map(d => d.conversationId))];
      const conversationCreatedMap = new Map<string, number>();
      if (conversationIds.length > 0) {
        const placeholders = conversationIds.map(() => '?').join(',');
        const convRows = await this.db.query<{ id: string; created: number }>(
          `SELECT id, created FROM conversations WHERE id IN (${placeholders})`,
          conversationIds
        );
        for (const row of convRows) {
          conversationCreatedMap.set(row.id, row.created);
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
        // Use pre-extracted referencedNotes from metadata instead of regex scanning
        if (item.referencedNotes && queryTerms.length > 0) {
          try {
            const refs = JSON.parse(item.referencedNotes) as string[];
            const hasMatchingRef = refs.some(ref =>
              queryTerms.some(term => ref.includes(term))
            );

            if (hasMatchingRef) {
              score = score * 0.9; // 10% boost
            }
          } catch {
            // Malformed JSON in referencedNotes -- skip boost
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

      // Batch fetch conversation titles (avoids N+1 queries)
      const topConvIds = [...new Set(topResults.map(r => r.conversationId))];
      const conversationTitleMap = new Map<string, string>();
      if (topConvIds.length > 0) {
        const titlePlaceholders = topConvIds.map(() => '?').join(',');
        const titleRows = await this.db.query<{ id: string; title: string }>(
          `SELECT id, title FROM conversations WHERE id IN (${titlePlaceholders})`,
          topConvIds
        );
        for (const row of titleRows) {
          conversationTitleMap.set(row.id, row.title);
        }
      }

      for (const item of topResults) {
        const conversationTitle = conversationTitleMap.get(item.conversationId) ?? 'Untitled';

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
      console.error('[ConversationEmbeddingService] Semantic conversation search failed:', error);
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
        `[ConversationEmbeddingService] Failed to remove conversation embeddings for ${conversationId}:`,
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
  async removeConversationPairEmbeddings(pairId: string): Promise<void> {
    const rows = await this.db.query<{ rowid: number }>(
      'SELECT rowid FROM conversation_embedding_metadata WHERE pairId = ?',
      [pairId]
    );

    for (const row of rows) {
      await this.db.run('DELETE FROM conversation_embeddings WHERE rowid = ?', [row.rowid]);
      await this.db.run('DELETE FROM conversation_embedding_metadata WHERE rowid = ?', [row.rowid]);
    }
  }

  /**
   * Clean up all embeddings for a deleted conversation.
   *
   * Public entry point intended to be called when a conversation is deleted.
   * Currently not wired to an event bus (no conversation deletion event exists
   * in the codebase). Callers should invoke this manually when deleting a
   * conversation to prevent orphaned embedding data.
   *
   * @param conversationId - The conversation being deleted
   */
  async onConversationDeleted(conversationId: string): Promise<void> {
    await this.removeConversationEmbeddings(conversationId);
  }

  /**
   * Get conversation embedding statistics
   *
   * @returns Count of conversation embedding chunks
   */
  async getConversationStats(): Promise<number> {
    try {
      const result = await this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM conversation_embedding_metadata'
      );
      return result?.count ?? 0;
    } catch (error) {
      console.error('[ConversationEmbeddingService] Failed to get stats:', error);
      return 0;
    }
  }
}
