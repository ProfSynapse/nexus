/**
 * ConversationEmbeddingService Unit Tests
 *
 * Tests the domain service responsible for embedding conversation QA pairs
 * and performing semantic search with multi-signal reranking.
 *
 * The semanticConversationSearch method has a 5-step pipeline:
 * 1. KNN query with workspace filter
 * 2. PairId deduplication (keep best chunk per pair)
 * 3. Multi-signal reranking: recency (20%), session density (15%), note refs (10%)
 * 4. Batch title lookup
 * 5. Full text retrieval from messages table
 *
 * Uses mocked SQLiteCacheManager and EmbeddingEngine for isolation.
 */

import { ConversationEmbeddingService, ConversationSearchResult } from '../../src/services/embeddings/ConversationEmbeddingService';
import type { EmbeddingEngine } from '../../src/services/embeddings/EmbeddingEngine';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import type { QAPair } from '../../src/services/embeddings/QAPairBuilder';

// ============================================================================
// Constants
// ============================================================================

const ONE_DAY_MS = 1000 * 60 * 60 * 24;

// ============================================================================
// Mock Factory
// ============================================================================

function createMockDependencies() {
  const mockDb = {
    queryOne: jest.fn().mockResolvedValue(null),
    query: jest.fn().mockResolvedValue([]),
    run: jest.fn().mockResolvedValue(undefined),
  };

  const mockEngine = {
    generateEmbedding: jest.fn().mockResolvedValue(new Float32Array(384)),
    getModelInfo: jest.fn().mockReturnValue({ id: 'test-model', dimensions: 384 }),
  };

  return { mockDb, mockEngine };
}

function createService(mocks: ReturnType<typeof createMockDependencies>) {
  return new ConversationEmbeddingService(
    mocks.mockDb as unknown as SQLiteCacheManager,
    mocks.mockEngine as unknown as EmbeddingEngine
  );
}

function createQAPair(overrides: Partial<QAPair> = {}): QAPair {
  return {
    pairId: 'conv-1:0',
    pairType: 'conversation_turn',
    question: 'How do I use the vault API?',
    answer: 'You can use app.vault.create() to create files.',
    conversationId: 'conv-1',
    sourceId: 'msg-user-1',
    startSequenceNumber: 0,
    endSequenceNumber: 1,
    contentHash: 'abc123',
    ...overrides,
  };
}

/**
 * Creates a KNN candidate row as returned by the vec0 KNN query.
 */
function createCandidate(overrides: Partial<{
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
}> = {}) {
  return {
    pairId: 'conv-1:0',
    side: 'question',
    conversationId: 'conv-1',
    startSequenceNumber: 0,
    endSequenceNumber: 1,
    pairType: 'conversation_turn',
    sessionId: null,
    workspaceId: 'ws-1',
    contentPreview: 'How do I use the vault API?',
    referencedNotes: null,
    distance: 0.5,
    created: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ConversationEmbeddingService', () => {
  let service: ConversationEmbeddingService;
  let mocks: ReturnType<typeof createMockDependencies>;

  beforeEach(() => {
    mocks = createMockDependencies();
    service = createService(mocks);
  });

  // ==========================================================================
  // embedConversationTurn
  // ==========================================================================

  describe('embedConversationTurn', () => {
    it('should skip embedding when contentHash matches existing', async () => {
      const qaPair = createQAPair({ contentHash: 'existing-hash' });
      mocks.mockDb.queryOne.mockResolvedValueOnce({ contentHash: 'existing-hash' });

      await service.embedConversationTurn(qaPair);

      // Should not generate any embeddings
      expect(mocks.mockEngine.generateEmbedding).not.toHaveBeenCalled();
      expect(mocks.mockDb.run).not.toHaveBeenCalled();
    });

    it('should re-embed when contentHash has changed (removes old first)', async () => {
      const qaPair = createQAPair({ contentHash: 'new-hash' });

      // Existing pair with different hash
      mocks.mockDb.queryOne
        .mockResolvedValueOnce({ contentHash: 'old-hash' })  // contentHash check
        .mockResolvedValueOnce({ id: 1 })                     // last_insert_rowid for Q chunk
        .mockResolvedValueOnce({ id: 2 });                    // last_insert_rowid for A chunk

      // removeConversationPairEmbeddings query
      mocks.mockDb.query.mockResolvedValueOnce([{ rowid: 10 }, { rowid: 11 }]);

      await service.embedConversationTurn(qaPair);

      // Should delete old embeddings
      expect(mocks.mockDb.run).toHaveBeenCalledWith(
        'DELETE FROM conversation_embeddings WHERE rowid = ?', [10]
      );
      expect(mocks.mockDb.run).toHaveBeenCalledWith(
        'DELETE FROM conversation_embedding_metadata WHERE rowid = ?', [10]
      );
      // Should generate new embeddings (once for Q, once for A)
      expect(mocks.mockEngine.generateEmbedding).toHaveBeenCalledTimes(2);
    });

    it('should embed both question and answer sides', async () => {
      const qaPair = createQAPair();

      // No existing embedding
      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)    // contentHash check: not found
        .mockResolvedValueOnce({ id: 1 })  // last_insert_rowid for Q
        .mockResolvedValueOnce({ id: 2 }); // last_insert_rowid for A

      await service.embedConversationTurn(qaPair);

      // Should generate 2 embeddings (Q + A)
      expect(mocks.mockEngine.generateEmbedding).toHaveBeenCalledTimes(2);
      expect(mocks.mockEngine.generateEmbedding).toHaveBeenCalledWith(
        expect.stringContaining('vault API')
      );
    });

    it('should skip empty question side', async () => {
      const qaPair = createQAPair({ question: '' });
      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)     // no existing
        .mockResolvedValueOnce({ id: 1 }); // last_insert_rowid for A

      await service.embedConversationTurn(qaPair);

      // Only one embedding generated (answer side)
      expect(mocks.mockEngine.generateEmbedding).toHaveBeenCalledTimes(1);
    });

    it('should skip whitespace-only answer side', async () => {
      const qaPair = createQAPair({ answer: '   \n\t  ' });
      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)     // no existing
        .mockResolvedValueOnce({ id: 1 }); // last_insert_rowid for Q

      await service.embedConversationTurn(qaPair);

      // Only one embedding generated (question side)
      expect(mocks.mockEngine.generateEmbedding).toHaveBeenCalledTimes(1);
    });

    it('should store wiki-links in referencedNotes metadata', async () => {
      const qaPair = createQAPair({
        answer: 'See [[Vault API]] and [[Plugin Lifecycle]] for details.',
      });
      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 1 })
        .mockResolvedValueOnce({ id: 2 });

      await service.embedConversationTurn(qaPair);

      // Check that metadata insert for the answer chunk includes referencedNotes
      const metadataInsertCalls = mocks.mockDb.run.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('conversation_embedding_metadata')
      );
      expect(metadataInsertCalls.length).toBeGreaterThanOrEqual(1);

      // Find the answer side metadata insert (second metadata insert)
      const answerMetadata = metadataInsertCalls[metadataInsertCalls.length - 1];
      const params = answerMetadata[1] as unknown[];
      const referencedNotesParam = params[14]; // referencedNotes is 15th param (index 14)
      expect(referencedNotesParam).not.toBeNull();
      const parsed = JSON.parse(referencedNotesParam as string);
      expect(parsed).toContain('vault api');
      expect(parsed).toContain('plugin lifecycle');
    });

    it('should not crash when embedding engine throws', async () => {
      const qaPair = createQAPair();
      mocks.mockDb.queryOne.mockResolvedValueOnce(null);
      mocks.mockEngine.generateEmbedding.mockRejectedValue(new Error('Engine crashed'));

      await service.embedConversationTurn(qaPair);

      // Should log error but not throw
      expect(console.error).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // semanticConversationSearch — Deduplication
  // ==========================================================================

  describe('semanticConversationSearch — deduplication', () => {
    it('should keep only the best chunk per pairId', async () => {
      const now = Date.now();

      // Two chunks from the same pair, different distances
      const candidates = [
        createCandidate({ pairId: 'conv-1:0', side: 'question', distance: 0.3, created: now }),
        createCandidate({ pairId: 'conv-1:0', side: 'answer', distance: 0.7, created: now }),
      ];

      // KNN query returns both chunks
      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)      // KNN candidates
        .mockResolvedValueOnce([])               // conversation timestamps batch
        .mockResolvedValueOnce([{ id: 'conv-1', title: 'Test Conv' }])  // titles
        .mockResolvedValueOnce([                 // messages
          { role: 'user', content: 'Q' },
          { role: 'assistant', content: 'A' },
        ]);

      const results = await service.semanticConversationSearch('vault API', 'ws-1');

      expect(results).toHaveLength(1);
      // Should keep the one with lower distance (0.3)
      expect(results[0].matchedSide).toBe('question');
    });

    it('should deduplicate across multiple pairs', async () => {
      const now = Date.now();

      const candidates = [
        createCandidate({ pairId: 'conv-1:0', distance: 0.2, created: now, conversationId: 'conv-1' }),
        createCandidate({ pairId: 'conv-1:0', distance: 0.8, created: now, conversationId: 'conv-1' }),
        createCandidate({ pairId: 'conv-2:0', distance: 0.4, created: now, conversationId: 'conv-2' }),
        createCandidate({ pairId: 'conv-2:0', distance: 0.6, created: now, conversationId: 'conv-2' }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([])  // conversation timestamps
        .mockResolvedValueOnce([
          { id: 'conv-1', title: 'Conv 1' },
          { id: 'conv-2', title: 'Conv 2' },
        ])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2' }]);

      const results = await service.semanticConversationSearch('test', 'ws-1');

      expect(results).toHaveLength(2);
    });
  });

  // ==========================================================================
  // semanticConversationSearch — Recency Boost
  // ==========================================================================

  describe('semanticConversationSearch — recency boost', () => {
    it('should boost recent conversations (within 14 days)', async () => {
      const now = Date.now();

      // Two pairs: one from today, one from 30 days ago, same raw distance
      const candidates = [
        createCandidate({
          pairId: 'old:0', distance: 0.5, created: now - (30 * ONE_DAY_MS),
          conversationId: 'old-conv',
        }),
        createCandidate({
          pairId: 'new:0', distance: 0.5, created: now - (1 * ONE_DAY_MS),
          conversationId: 'new-conv',
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([
          { id: 'old-conv', created: now - (30 * ONE_DAY_MS) },
          { id: 'new-conv', created: now - (1 * ONE_DAY_MS) },
        ])
        .mockResolvedValueOnce([
          { id: 'old-conv', title: 'Old Conv' },
          { id: 'new-conv', title: 'New Conv' },
        ])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]);

      const results = await service.semanticConversationSearch('test', 'ws-1');

      expect(results).toHaveLength(2);
      // Recent should be ranked higher (lower score) due to recency boost
      expect(results[0].pairId).toBe('new:0');
      expect(results[0].score).toBeLessThan(results[1].score);
    });

    it('should apply maximum 20% recency boost for very recent (today)', async () => {
      const now = Date.now();

      const candidates = [
        createCandidate({
          pairId: 'today:0', distance: 1.0, created: now,
          conversationId: 'today-conv',
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([{ id: 'today-conv', created: now }])
        .mockResolvedValueOnce([{ id: 'today-conv', title: 'Today' }])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]);

      const results = await service.semanticConversationSearch('test', 'ws-1');

      // Score should be distance * (1 - 0.20) = 1.0 * 0.80 = 0.80
      expect(results[0].score).toBeCloseTo(0.80, 2);
    });

    it('should not boost conversations older than 14 days', async () => {
      const now = Date.now();

      const candidates = [
        createCandidate({
          pairId: 'old:0', distance: 1.0, created: now - (15 * ONE_DAY_MS),
          conversationId: 'old-conv',
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([{ id: 'old-conv', created: now - (15 * ONE_DAY_MS) }])
        .mockResolvedValueOnce([{ id: 'old-conv', title: 'Old' }])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]);

      const results = await service.semanticConversationSearch('test', 'ws-1');

      // No recency boost: score should equal raw distance
      expect(results[0].score).toBeCloseTo(1.0, 2);
    });

    it('should scale recency boost linearly over 14 days', async () => {
      const now = Date.now();

      // Conversation from exactly 7 days ago (midpoint)
      const candidates = [
        createCandidate({
          pairId: 'mid:0', distance: 1.0, created: now - (7 * ONE_DAY_MS),
          conversationId: 'mid-conv',
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([{ id: 'mid-conv', created: now - (7 * ONE_DAY_MS) }])
        .mockResolvedValueOnce([{ id: 'mid-conv', title: 'Mid' }])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]);

      const results = await service.semanticConversationSearch('test', 'ws-1');

      // At 7 days: boost = 0.20 * (1 - 7/14) = 0.20 * 0.5 = 0.10
      // score = 1.0 * (1 - 0.10) = 0.90
      expect(results[0].score).toBeCloseTo(0.90, 2);
    });
  });

  // ==========================================================================
  // semanticConversationSearch — Session Density Boost
  // ==========================================================================

  describe('semanticConversationSearch — session density boost', () => {
    it('should boost results in sessions with multiple hits', async () => {
      const now = Date.now();
      const oldCreated = now - (20 * ONE_DAY_MS); // Beyond recency window to isolate density

      const candidates = [
        createCandidate({
          pairId: 'dense:0', distance: 0.5, sessionId: 'sess-dense',
          conversationId: 'conv-dense-1', created: oldCreated,
        }),
        createCandidate({
          pairId: 'dense:2', distance: 0.5, sessionId: 'sess-dense',
          conversationId: 'conv-dense-2', created: oldCreated,
        }),
        createCandidate({
          pairId: 'sparse:0', distance: 0.5, sessionId: 'sess-sparse',
          conversationId: 'conv-sparse', created: oldCreated,
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([
          { id: 'conv-dense-1', created: oldCreated },
          { id: 'conv-dense-2', created: oldCreated },
          { id: 'conv-sparse', created: oldCreated },
        ])
        .mockResolvedValueOnce([
          { id: 'conv-dense-1', title: 'Dense 1' },
          { id: 'conv-dense-2', title: 'Dense 2' },
          { id: 'conv-sparse', title: 'Sparse' },
        ])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]);

      const results = await service.semanticConversationSearch('test', 'ws-1');

      // Dense session items (2 hits) should be boosted
      const denseResults = results.filter(r => r.sessionId === 'sess-dense');
      const sparseResult = results.find(r => r.sessionId === 'sess-sparse');

      expect(denseResults.length).toBe(2);
      expect(sparseResult).toBeDefined();

      // Dense items should have lower score (better) than sparse item
      for (const dr of denseResults) {
        expect(dr.score).toBeLessThan(sparseResult!.score);
      }
    });

    it('should not boost sessions with only 1 hit', async () => {
      const now = Date.now();
      const oldCreated = now - (20 * ONE_DAY_MS);

      const candidates = [
        createCandidate({
          pairId: 'single:0', distance: 1.0, sessionId: 'sess-single',
          conversationId: 'conv-1', created: oldCreated,
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([{ id: 'conv-1', created: oldCreated }])
        .mockResolvedValueOnce([{ id: 'conv-1', title: 'Test' }])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]);

      const results = await service.semanticConversationSearch('test', 'ws-1');

      // No density boost (hitCount < 2): score = raw distance
      expect(results[0].score).toBeCloseTo(1.0, 2);
    });

    it('should cap session density boost at 15%', async () => {
      const now = Date.now();
      const oldCreated = now - (20 * ONE_DAY_MS);

      // 5 results in same session (hitCount=5, (5-1)/3 = 1.33, capped at 1)
      const candidates = Array.from({ length: 5 }, (_, i) =>
        createCandidate({
          pairId: `dense:${i * 2}`,
          distance: 1.0,
          sessionId: 'sess-super-dense',
          conversationId: `conv-d-${i}`,
          created: oldCreated,
        })
      );

      const convTimestamps = candidates.map(c => ({ id: c.conversationId, created: oldCreated }));
      const convTitles = candidates.map(c => ({ id: c.conversationId, title: `Title ${c.conversationId}` }));
      const messageResponse = [{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce(convTimestamps)
        .mockResolvedValueOnce(convTitles);

      for (let i = 0; i < 5; i++) {
        mocks.mockDb.query.mockResolvedValueOnce(messageResponse);
      }

      const results = await service.semanticConversationSearch('test', 'ws-1');

      // With 5 hits: boost = 0.15 * min(1, 4/3) = 0.15 * 1 = 0.15
      // score = 1.0 * (1 - 0.15) = 0.85
      for (const r of results) {
        expect(r.score).toBeCloseTo(0.85, 2);
      }
    });
  });

  // ==========================================================================
  // semanticConversationSearch — Note Reference Boost
  // ==========================================================================

  describe('semanticConversationSearch — note reference boost', () => {
    it('should boost results with wiki-links matching query terms', async () => {
      const now = Date.now();
      const oldCreated = now - (20 * ONE_DAY_MS);

      const candidates = [
        createCandidate({
          pairId: 'refs:0', distance: 0.5,
          referencedNotes: JSON.stringify(['vault api', 'plugin lifecycle']),
          conversationId: 'conv-ref', created: oldCreated,
        }),
        createCandidate({
          pairId: 'norefs:0', distance: 0.5,
          referencedNotes: null,
          conversationId: 'conv-noref', created: oldCreated,
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([
          { id: 'conv-ref', created: oldCreated },
          { id: 'conv-noref', created: oldCreated },
        ])
        .mockResolvedValueOnce([
          { id: 'conv-ref', title: 'With Refs' },
          { id: 'conv-noref', title: 'No Refs' },
        ])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]);

      // Query contains "vault" which matches "vault api" in referencedNotes
      const results = await service.semanticConversationSearch('vault documentation', 'ws-1');

      const withRefs = results.find(r => r.pairId === 'refs:0');
      const withoutRefs = results.find(r => r.pairId === 'norefs:0');

      expect(withRefs).toBeDefined();
      expect(withoutRefs).toBeDefined();
      // Result with matching refs should have lower score (boosted by 10%)
      expect(withRefs!.score).toBeLessThan(withoutRefs!.score);
      expect(withRefs!.score).toBeCloseTo(0.5 * 0.9, 2); // 10% boost
      expect(withoutRefs!.score).toBeCloseTo(0.5, 2);      // no boost
    });

    it('should not boost when query terms are too short (<=2 chars)', async () => {
      const now = Date.now();
      const oldCreated = now - (20 * ONE_DAY_MS);

      const candidates = [
        createCandidate({
          pairId: 'refs:0', distance: 1.0,
          referencedNotes: JSON.stringify(['it', 'a']),
          conversationId: 'conv-1', created: oldCreated,
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([{ id: 'conv-1', created: oldCreated }])
        .mockResolvedValueOnce([{ id: 'conv-1', title: 'Test' }])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]);

      // Query with very short words (all <=2 chars stripped)
      const results = await service.semanticConversationSearch('it is a', 'ws-1');

      // No boost: all query terms filtered out
      expect(results[0].score).toBeCloseTo(1.0, 2);
    });

    it('should handle malformed JSON in referencedNotes gracefully', async () => {
      const now = Date.now();
      const oldCreated = now - (20 * ONE_DAY_MS);

      const candidates = [
        createCandidate({
          pairId: 'bad:0', distance: 1.0,
          referencedNotes: 'not-valid-json{{{',
          conversationId: 'conv-1', created: oldCreated,
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([{ id: 'conv-1', created: oldCreated }])
        .mockResolvedValueOnce([{ id: 'conv-1', title: 'Test' }])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]);

      const results = await service.semanticConversationSearch('vault info', 'ws-1');

      // Should not crash and score should be unaffected
      expect(results).toHaveLength(1);
      expect(results[0].score).toBeCloseTo(1.0, 2);
    });
  });

  // ==========================================================================
  // semanticConversationSearch — Combined Boosts
  // ==========================================================================

  describe('semanticConversationSearch — combined boosts', () => {
    it('should apply recency, density, and reference boosts together', async () => {
      const now = Date.now();
      const recentCreated = now - (1 * ONE_DAY_MS); // 1 day ago

      // Two results in the same session with wiki-links matching query
      const candidates = [
        createCandidate({
          pairId: 'boosted:0', distance: 1.0,
          sessionId: 'sess-1',
          referencedNotes: JSON.stringify(['vault']),
          conversationId: 'conv-boosted', created: recentCreated,
        }),
        createCandidate({
          pairId: 'boosted:2', distance: 1.0,
          sessionId: 'sess-1',
          referencedNotes: null,
          conversationId: 'conv-boosted-2', created: recentCreated,
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([
          { id: 'conv-boosted', created: recentCreated },
          { id: 'conv-boosted-2', created: recentCreated },
        ])
        .mockResolvedValueOnce([
          { id: 'conv-boosted', title: 'Boosted 1' },
          { id: 'conv-boosted-2', title: 'Boosted 2' },
        ])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]);

      const results = await service.semanticConversationSearch('vault', 'ws-1');

      // First result: recency + density + reference = all three boosts
      const fullyBoosted = results.find(r => r.pairId === 'boosted:0');
      const partiallyBoosted = results.find(r => r.pairId === 'boosted:2');

      expect(fullyBoosted).toBeDefined();
      expect(partiallyBoosted).toBeDefined();

      // Fully boosted should have lower score than partially boosted
      expect(fullyBoosted!.score).toBeLessThan(partiallyBoosted!.score);

      // Both should be less than raw distance (1.0)
      expect(fullyBoosted!.score).toBeLessThan(1.0);
      expect(partiallyBoosted!.score).toBeLessThan(1.0);
    });
  });

  // ==========================================================================
  // semanticConversationSearch — Session Filter
  // ==========================================================================

  describe('semanticConversationSearch — session filter', () => {
    it('should filter by sessionId when provided', async () => {
      const now = Date.now();
      const oldCreated = now - (20 * ONE_DAY_MS);

      const candidates = [
        createCandidate({
          pairId: 'match:0', distance: 0.3,
          sessionId: 'sess-target', conversationId: 'conv-match', created: oldCreated,
        }),
        createCandidate({
          pairId: 'nomatch:0', distance: 0.1,
          sessionId: 'sess-other', conversationId: 'conv-nomatch', created: oldCreated,
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([{ id: 'conv-match', created: oldCreated }])
        .mockResolvedValueOnce([{ id: 'conv-match', title: 'Match' }])
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]);

      const results = await service.semanticConversationSearch('test', 'ws-1', 'sess-target');

      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe('sess-target');
    });
  });

  // ==========================================================================
  // semanticConversationSearch — Full Text Retrieval
  // ==========================================================================

  describe('semanticConversationSearch — full text retrieval', () => {
    it('should fetch full question and answer from messages table', async () => {
      const now = Date.now();
      const oldCreated = now - (20 * ONE_DAY_MS);

      const candidates = [
        createCandidate({
          pairId: 'conv-1:0', distance: 0.5,
          conversationId: 'conv-1', startSequenceNumber: 0, endSequenceNumber: 1,
          created: oldCreated,
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([{ id: 'conv-1', created: oldCreated }])
        .mockResolvedValueOnce([{ id: 'conv-1', title: 'My Conversation' }])
        .mockResolvedValueOnce([
          { role: 'user', content: 'What is the Obsidian API?' },
          { role: 'assistant', content: 'The Obsidian API provides methods for vault operations.' },
        ]);

      const results = await service.semanticConversationSearch('test', 'ws-1');

      expect(results[0].question).toBe('What is the Obsidian API?');
      expect(results[0].answer).toBe('The Obsidian API provides methods for vault operations.');
      expect(results[0].conversationTitle).toBe('My Conversation');
    });

    it('should use "Untitled" when conversation title is not found', async () => {
      const now = Date.now();
      const oldCreated = now - (20 * ONE_DAY_MS);

      const candidates = [
        createCandidate({
          pairId: 'conv-missing:0', distance: 0.5,
          conversationId: 'conv-missing', created: oldCreated,
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([])  // No matching conversation timestamps
        .mockResolvedValueOnce([])  // No titles found
        .mockResolvedValueOnce([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]);

      const results = await service.semanticConversationSearch('test', 'ws-1');

      expect(results[0].conversationTitle).toBe('Untitled');
    });

    it('should handle messages with null content', async () => {
      const now = Date.now();
      const oldCreated = now - (20 * ONE_DAY_MS);

      const candidates = [
        createCandidate({
          pairId: 'conv-null:0', distance: 0.5,
          conversationId: 'conv-null', created: oldCreated,
        }),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([{ id: 'conv-null', created: oldCreated }])
        .mockResolvedValueOnce([{ id: 'conv-null', title: 'Test' }])
        .mockResolvedValueOnce([
          { role: 'user', content: null },
          { role: 'assistant', content: null },
        ]);

      const results = await service.semanticConversationSearch('test', 'ws-1');

      expect(results[0].question).toBe('');
      expect(results[0].answer).toBe('');
    });
  });

  // ==========================================================================
  // semanticConversationSearch — Limit
  // ==========================================================================

  describe('semanticConversationSearch — limit', () => {
    it('should respect the limit parameter', async () => {
      const now = Date.now();
      const oldCreated = now - (20 * ONE_DAY_MS);

      const candidates = Array.from({ length: 10 }, (_, i) =>
        createCandidate({
          pairId: `conv-${i}:0`,
          distance: 0.1 * (i + 1),
          conversationId: `conv-${i}`,
          created: oldCreated,
        })
      );

      const convTimestamps = candidates.map(c => ({ id: c.conversationId, created: oldCreated }));
      const convTitles = candidates.map(c => ({ id: c.conversationId, title: `Title ${c.conversationId}` }));

      mocks.mockDb.query
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce(convTimestamps)
        .mockResolvedValueOnce(convTitles);

      // Add message responses for limited results
      for (let i = 0; i < 3; i++) {
        mocks.mockDb.query.mockResolvedValueOnce([
          { role: 'user', content: 'Q' },
          { role: 'assistant', content: 'A' },
        ]);
      }

      const results = await service.semanticConversationSearch('test', 'ws-1', undefined, 3);

      expect(results).toHaveLength(3);
    });

    it('should fetch limit*3 candidates for reranking headroom', async () => {
      mocks.mockDb.query.mockResolvedValueOnce([]);

      await service.semanticConversationSearch('test', 'ws-1', undefined, 5);

      // Check the LIMIT parameter passed to the KNN query
      const knnCall = mocks.mockDb.query.mock.calls[0];
      const params = knnCall[1] as unknown[];
      expect(params[params.length - 1]).toBe(15); // limit * 3
    });
  });

  // ==========================================================================
  // semanticConversationSearch — Empty / Error Cases
  // ==========================================================================

  describe('semanticConversationSearch — empty and error cases', () => {
    it('should return empty array when no candidates found', async () => {
      mocks.mockDb.query.mockResolvedValueOnce([]);

      const results = await service.semanticConversationSearch('test', 'ws-1');

      expect(results).toEqual([]);
    });

    it('should return empty array when engine throws', async () => {
      mocks.mockEngine.generateEmbedding.mockRejectedValue(new Error('Engine error'));

      const results = await service.semanticConversationSearch('test', 'ws-1');

      expect(results).toEqual([]);
      expect(console.error).toHaveBeenCalled();
    });

    it('should return empty array when KNN query throws', async () => {
      mocks.mockDb.query.mockRejectedValueOnce(new Error('DB error'));

      const results = await service.semanticConversationSearch('test', 'ws-1');

      expect(results).toEqual([]);
    });
  });

  // ==========================================================================
  // removeConversationEmbeddings
  // ==========================================================================

  describe('removeConversationEmbeddings', () => {
    it('should delete all embeddings and metadata for a conversation', async () => {
      mocks.mockDb.query.mockResolvedValueOnce([{ rowid: 10 }, { rowid: 20 }, { rowid: 30 }]);

      await service.removeConversationEmbeddings('conv-to-delete');

      // Should delete from both tables for each row
      expect(mocks.mockDb.run).toHaveBeenCalledTimes(6); // 3 rows x 2 deletes each
      expect(mocks.mockDb.run).toHaveBeenCalledWith(
        'DELETE FROM conversation_embeddings WHERE rowid = ?', [10]
      );
      expect(mocks.mockDb.run).toHaveBeenCalledWith(
        'DELETE FROM conversation_embedding_metadata WHERE rowid = ?', [10]
      );
    });

    it('should handle empty result (no embeddings to delete)', async () => {
      mocks.mockDb.query.mockResolvedValueOnce([]);

      await service.removeConversationEmbeddings('conv-no-embeddings');

      expect(mocks.mockDb.run).not.toHaveBeenCalled();
    });

    it('should not throw when delete query fails', async () => {
      mocks.mockDb.query.mockRejectedValueOnce(new Error('DB unavailable'));

      await service.removeConversationEmbeddings('conv-error');

      expect(console.error).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // removeConversationPairEmbeddings
  // ==========================================================================

  describe('removeConversationPairEmbeddings', () => {
    it('should delete all chunks for a specific pairId', async () => {
      mocks.mockDb.query.mockResolvedValueOnce([{ rowid: 5 }, { rowid: 6 }]);

      await service.removeConversationPairEmbeddings('conv-1:0');

      expect(mocks.mockDb.run).toHaveBeenCalledTimes(4); // 2 rows x 2 deletes
    });
  });

  // ==========================================================================
  // onConversationDeleted
  // ==========================================================================

  describe('onConversationDeleted', () => {
    it('should delegate to removeConversationEmbeddings', async () => {
      mocks.mockDb.query.mockResolvedValueOnce([{ rowid: 1 }]);

      await service.onConversationDeleted('conv-deleted');

      // Should query for the conversation's embeddings
      expect(mocks.mockDb.query).toHaveBeenCalledWith(
        'SELECT rowid FROM conversation_embedding_metadata WHERE conversationId = ?',
        ['conv-deleted']
      );
    });
  });

  // ==========================================================================
  // getConversationStats
  // ==========================================================================

  describe('getConversationStats', () => {
    it('should return the count of conversation embedding chunks', async () => {
      mocks.mockDb.queryOne.mockResolvedValueOnce({ count: 42 });

      const count = await service.getConversationStats();

      expect(count).toBe(42);
    });

    it('should return 0 when query returns null', async () => {
      mocks.mockDb.queryOne.mockResolvedValueOnce(null);

      const count = await service.getConversationStats();

      expect(count).toBe(0);
    });

    it('should return 0 when query throws', async () => {
      mocks.mockDb.queryOne.mockRejectedValueOnce(new Error('DB error'));

      const count = await service.getConversationStats();

      expect(count).toBe(0);
      expect(console.error).toHaveBeenCalled();
    });
  });
});
