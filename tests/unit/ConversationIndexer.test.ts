/**
 * ConversationIndexer Unit Tests
 *
 * Tests the backfill indexer that processes existing conversations
 * newest-first, with resume-on-interrupt support via the
 * embedding_backfill_state table.
 *
 * Key behaviors tested:
 * - Normal backfill flow (process all conversations)
 * - Resume from interrupted backfill
 * - Abort signal handling
 * - Branch conversation filtering
 * - Progress reporting and periodic saves
 * - Error resilience (individual conversation failures don't halt backfill)
 */

import { ConversationIndexer, ConversationIndexerProgress } from '../../src/services/embeddings/ConversationIndexer';
import type { EmbeddingService } from '../../src/services/embeddings/EmbeddingService';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';

// ============================================================================
// Mock Factory
// ============================================================================

function createMockDependencies() {
  const progressCalls: ConversationIndexerProgress[] = [];
  const onProgress = jest.fn((progress: ConversationIndexerProgress) => {
    progressCalls.push({ ...progress });
  });

  const mockDb = {
    queryOne: jest.fn().mockResolvedValue(null),
    query: jest.fn().mockResolvedValue([]),
    run: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue(undefined),
  };

  const mockEmbeddingService = {
    isServiceEnabled: jest.fn().mockReturnValue(true),
    embedConversationTurn: jest.fn().mockResolvedValue(undefined),
  };

  return { mockDb, mockEmbeddingService, onProgress, progressCalls };
}

function createIndexer(
  mocks: ReturnType<typeof createMockDependencies>,
  saveInterval = 10
) {
  return new ConversationIndexer(
    mocks.mockDb as unknown as SQLiteCacheManager,
    mocks.mockEmbeddingService as unknown as EmbeddingService,
    mocks.onProgress,
    saveInterval
  );
}

/** Creates a conversation row as returned by the DB query. */
function createConversationRow(id: string, overrides: Partial<{
  metadataJson: string | null;
  workspaceId: string | null;
  sessionId: string | null;
}> = {}) {
  return {
    id,
    metadataJson: null,
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    ...overrides,
  };
}

/** Creates a message row for the backfillConversation query. */
function createMessageRow(overrides: Partial<{
  id: string;
  conversationId: string;
  role: string;
  content: string | null;
  timestamp: number;
  state: string | null;
  toolCallsJson: string | null;
  toolCallId: string | null;
  sequenceNumber: number;
  reasoningContent: string | null;
  alternativesJson: string | null;
  activeAlternativeIndex: number;
}> = {}) {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    role: 'user',
    content: 'Test content',
    timestamp: Date.now(),
    state: 'complete',
    toolCallsJson: null,
    toolCallId: null,
    sequenceNumber: 0,
    reasoningContent: null,
    alternativesJson: null,
    activeAlternativeIndex: 0,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ConversationIndexer', () => {
  let indexer: ConversationIndexer;
  let mocks: ReturnType<typeof createMockDependencies>;

  beforeEach(() => {
    mocks = createMockDependencies();
    indexer = createIndexer(mocks);
  });

  // ==========================================================================
  // getIsRunning
  // ==========================================================================

  describe('getIsRunning', () => {
    it('should return false initially', () => {
      expect(indexer.getIsRunning()).toBe(false);
    });
  });

  // ==========================================================================
  // Guard Conditions
  // ==========================================================================

  describe('guard conditions', () => {
    it('should return early if already running', async () => {
      // Start a backfill that will block
      mocks.mockDb.queryOne.mockResolvedValueOnce(null); // no existing state
      const conversations = [createConversationRow('conv-1')];
      mocks.mockDb.query
        .mockResolvedValueOnce(conversations) // conversations list
        .mockImplementationOnce(() => new Promise(() => {})); // block on messages query

      // Start first run (will block)
      const firstRun = indexer.start(null, 100);

      // Allow microtask to set isRunning
      await new Promise(r => setTimeout(r, 10));

      // Second call should return immediately
      const result = await indexer.start(null);
      expect(result).toEqual({ total: 0, processed: 0 });

      // Clean up: abort the blocked run so Jest doesn't hang
      // We don't await firstRun since it's blocked
    });

    it('should return early if embedding service is disabled', async () => {
      mocks.mockEmbeddingService.isServiceEnabled.mockReturnValue(false);

      const result = await indexer.start(null);

      expect(result).toEqual({ total: 0, processed: 0 });
      expect(mocks.mockDb.queryOne).not.toHaveBeenCalled();
    });

    it('should return early if backfill already completed', async () => {
      mocks.mockDb.queryOne.mockResolvedValueOnce({
        id: 'conversation_backfill',
        lastProcessedConversationId: 'conv-last',
        totalConversations: 10,
        processedConversations: 10,
        status: 'completed',
        startedAt: Date.now(),
        completedAt: Date.now(),
        errorMessage: null,
      });

      const result = await indexer.start(null);

      expect(result).toEqual({ total: 0, processed: 0 });
    });
  });

  // ==========================================================================
  // Normal Backfill Flow
  // ==========================================================================

  describe('normal backfill flow', () => {
    it('should process all non-branch conversations', async () => {
      const conversations = [
        createConversationRow('conv-1'),
        createConversationRow('conv-2'),
      ];

      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)  // no existing backfill state
        .mockResolvedValueOnce(null)  // updateBackfillState check (running)
        .mockResolvedValueOnce({ id: 'conversation_backfill' }) // updateBackfillState check (completed)
        ;

      mocks.mockDb.query
        .mockResolvedValueOnce(conversations)  // allConversations
        .mockResolvedValueOnce([               // messages for conv-1
          createMessageRow({ id: 'msg-1', conversationId: 'conv-1', role: 'user', sequenceNumber: 0 }),
          createMessageRow({ id: 'msg-2', conversationId: 'conv-1', role: 'assistant', sequenceNumber: 1 }),
        ])
        .mockResolvedValueOnce([               // messages for conv-2
          createMessageRow({ id: 'msg-3', conversationId: 'conv-2', role: 'user', sequenceNumber: 0 }),
          createMessageRow({ id: 'msg-4', conversationId: 'conv-2', role: 'assistant', sequenceNumber: 1 }),
        ]);

      const result = await indexer.start(null, 100);

      expect(result.total).toBe(2);
      expect(result.processed).toBe(2);
      // embedConversationTurn called once per QA pair per conversation
      expect(mocks.mockEmbeddingService.embedConversationTurn).toHaveBeenCalled();
    });

    it('should filter out branch conversations', async () => {
      const conversations = [
        createConversationRow('conv-main'),
        createConversationRow('conv-branch', {
          metadataJson: JSON.stringify({ parentConversationId: 'conv-main' }),
        }),
      ];

      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)   // no existing state
        .mockResolvedValueOnce(null)   // updateBackfillState (running)
        .mockResolvedValueOnce({ id: 'conversation_backfill' }); // updateBackfillState (completed)

      mocks.mockDb.query
        .mockResolvedValueOnce(conversations)
        .mockResolvedValueOnce([
          createMessageRow({ conversationId: 'conv-main', role: 'user', sequenceNumber: 0 }),
          createMessageRow({ conversationId: 'conv-main', role: 'assistant', sequenceNumber: 1 }),
        ]);

      const result = await indexer.start(null, 100);

      // Only 1 conversation should be processed (branch filtered out)
      expect(result.total).toBe(1);
      expect(result.processed).toBe(1);
    });

    it('should treat conversations with malformed metadataJson as non-branch', async () => {
      const conversations = [
        createConversationRow('conv-bad-json', {
          metadataJson: 'not-valid-json{{{',
        }),
      ];

      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'conversation_backfill' });

      mocks.mockDb.query
        .mockResolvedValueOnce(conversations)
        .mockResolvedValueOnce([
          createMessageRow({ role: 'user', sequenceNumber: 0 }),
          createMessageRow({ role: 'assistant', sequenceNumber: 1 }),
        ]);

      const result = await indexer.start(null, 100);

      // Should be treated as a non-branch and processed
      expect(result.total).toBe(1);
    });

    it('should handle empty conversations list', async () => {
      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)    // no existing state
        .mockResolvedValueOnce(null);   // updateBackfillState (completed with 0)

      mocks.mockDb.query.mockResolvedValueOnce([]); // no conversations

      const result = await indexer.start(null);

      expect(result).toEqual({ total: 0, processed: 0 });
    });

    it('should skip conversations with no messages', async () => {
      const conversations = [createConversationRow('conv-empty')];

      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'conversation_backfill' });

      mocks.mockDb.query
        .mockResolvedValueOnce(conversations)
        .mockResolvedValueOnce([]); // no messages

      const result = await indexer.start(null, 100);

      expect(result.processed).toBe(1); // Processed but no QA pairs generated
      expect(mocks.mockEmbeddingService.embedConversationTurn).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Resume from Interrupted Backfill
  // ==========================================================================

  describe('resume from interrupted backfill', () => {
    it('should resume from the last processed conversation', async () => {
      const conversations = [
        createConversationRow('conv-1'),
        createConversationRow('conv-2'),
        createConversationRow('conv-3'),
      ];

      // Existing state: conv-1 already processed
      mocks.mockDb.queryOne
        .mockResolvedValueOnce({
          id: 'conversation_backfill',
          lastProcessedConversationId: 'conv-1',
          totalConversations: 3,
          processedConversations: 1,
          status: 'running',
          startedAt: Date.now(),
          completedAt: null,
          errorMessage: null,
        })
        .mockResolvedValueOnce({ id: 'conversation_backfill' }) // updateBackfillState (running)
        .mockResolvedValueOnce({ id: 'conversation_backfill' }); // updateBackfillState (completed)

      mocks.mockDb.query
        .mockResolvedValueOnce(conversations)
        .mockResolvedValueOnce([  // messages for conv-2
          createMessageRow({ conversationId: 'conv-2', role: 'user', sequenceNumber: 0 }),
          createMessageRow({ conversationId: 'conv-2', role: 'assistant', sequenceNumber: 1 }),
        ])
        .mockResolvedValueOnce([  // messages for conv-3
          createMessageRow({ conversationId: 'conv-3', role: 'user', sequenceNumber: 0 }),
          createMessageRow({ conversationId: 'conv-3', role: 'assistant', sequenceNumber: 1 }),
        ]);

      const result = await indexer.start(null, 100);

      expect(result.total).toBe(3);
      expect(result.processed).toBe(3); // 1 previously + 2 new
    });

    it('should complete immediately when all conversations already processed', async () => {
      const conversations = [
        createConversationRow('conv-1'),
        createConversationRow('conv-2'),
      ];

      // Existing state: conv-2 (last) already processed
      mocks.mockDb.queryOne
        .mockResolvedValueOnce({
          id: 'conversation_backfill',
          lastProcessedConversationId: 'conv-2',
          totalConversations: 2,
          processedConversations: 2,
          status: 'running',
          startedAt: Date.now(),
          completedAt: null,
          errorMessage: null,
        })
        .mockResolvedValueOnce({ id: 'conversation_backfill' }); // updateBackfillState (completed)

      mocks.mockDb.query.mockResolvedValueOnce(conversations);

      const result = await indexer.start(null, 100);

      expect(result.total).toBe(2);
      expect(result.processed).toBe(2);
    });
  });

  // ==========================================================================
  // Abort Signal Handling
  // ==========================================================================

  describe('abort signal handling', () => {
    it('should stop processing when abort signal fires', async () => {
      const abortController = new AbortController();
      const conversations = [
        createConversationRow('conv-1'),
        createConversationRow('conv-2'),
        createConversationRow('conv-3'),
      ];

      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)   // no existing state
        .mockResolvedValueOnce(null)   // updateBackfillState (running)
        .mockResolvedValueOnce({ id: 'conversation_backfill' }); // updateBackfillState (completed)

      let queryCount = 0;
      mocks.mockDb.query.mockImplementation(async () => {
        queryCount++;
        if (queryCount === 1) {
          return conversations; // allConversations
        }
        // After first conversation, abort
        if (queryCount === 2) {
          abortController.abort();
          return [
            createMessageRow({ role: 'user', sequenceNumber: 0 }),
            createMessageRow({ role: 'assistant', sequenceNumber: 1 }),
          ];
        }
        return [
          createMessageRow({ role: 'user', sequenceNumber: 0 }),
          createMessageRow({ role: 'assistant', sequenceNumber: 1 }),
        ];
      });

      const result = await indexer.start(abortController.signal, 100);

      // Should process conv-1 then abort before conv-2
      expect(result.processed).toBeLessThan(3);
    });

    it('should set isRunning to false after abort', async () => {
      const abortController = new AbortController();
      abortController.abort(); // Pre-abort

      mocks.mockDb.queryOne.mockResolvedValueOnce(null);
      mocks.mockDb.query.mockResolvedValueOnce([createConversationRow('conv-1')]);

      // Need to mock for updateBackfillState calls
      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)  // updateBackfillState (running)
        .mockResolvedValueOnce({ id: 'conversation_backfill' }); // updateBackfillState (completed)

      await indexer.start(abortController.signal, 100);

      expect(indexer.getIsRunning()).toBe(false);
    });
  });

  // ==========================================================================
  // Progress Reporting
  // ==========================================================================

  describe('progress reporting', () => {
    it('should emit progress after each conversation', async () => {
      const conversations = [
        createConversationRow('conv-1'),
        createConversationRow('conv-2'),
      ];

      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'conversation_backfill' });

      mocks.mockDb.query
        .mockResolvedValueOnce(conversations)
        .mockResolvedValueOnce([
          createMessageRow({ role: 'user', sequenceNumber: 0 }),
          createMessageRow({ role: 'assistant', sequenceNumber: 1 }),
        ])
        .mockResolvedValueOnce([
          createMessageRow({ role: 'user', sequenceNumber: 0 }),
          createMessageRow({ role: 'assistant', sequenceNumber: 1 }),
        ]);

      await indexer.start(null, 100);

      // Initial progress + one per conversation
      expect(mocks.onProgress).toHaveBeenCalledTimes(3);

      // First call: initial state
      expect(mocks.progressCalls[0]).toEqual({
        totalConversations: 2,
        processedConversations: 0,
      });
      // After processing conv-1
      expect(mocks.progressCalls[1]).toEqual({
        totalConversations: 2,
        processedConversations: 1,
      });
      // After processing conv-2
      expect(mocks.progressCalls[2]).toEqual({
        totalConversations: 2,
        processedConversations: 2,
      });
    });
  });

  // ==========================================================================
  // Periodic Save
  // ==========================================================================

  describe('periodic save', () => {
    it('should save to database at saveInterval', async () => {
      // Use saveInterval of 2
      indexer = createIndexer(mocks, 2);

      const conversations = [
        createConversationRow('conv-1'),
        createConversationRow('conv-2'),
        createConversationRow('conv-3'),
      ];

      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)   // updateBackfillState (running)
        .mockResolvedValueOnce({ id: 'conversation_backfill' }) // periodic save updateBackfillState
        .mockResolvedValueOnce({ id: 'conversation_backfill' }); // final updateBackfillState

      mocks.mockDb.query
        .mockResolvedValueOnce(conversations)
        .mockResolvedValueOnce([createMessageRow({ role: 'user', sequenceNumber: 0 }), createMessageRow({ role: 'assistant', sequenceNumber: 1 })])
        .mockResolvedValueOnce([createMessageRow({ role: 'user', sequenceNumber: 0 }), createMessageRow({ role: 'assistant', sequenceNumber: 1 })])
        .mockResolvedValueOnce([createMessageRow({ role: 'user', sequenceNumber: 0 }), createMessageRow({ role: 'assistant', sequenceNumber: 1 })]);

      await indexer.start(null, 100);

      // db.save should be called at saveInterval (after 2nd conv) and at end
      expect(mocks.mockDb.save).toHaveBeenCalledTimes(2); // periodic + final
    });
  });

  // ==========================================================================
  // Error Resilience
  // ==========================================================================

  describe('error resilience', () => {
    it('should continue backfill when individual conversation fails', async () => {
      const conversations = [
        createConversationRow('conv-fail'),
        createConversationRow('conv-ok'),
      ];

      mocks.mockDb.queryOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'conversation_backfill' });

      let queryCount = 0;
      mocks.mockDb.query.mockImplementation(async () => {
        queryCount++;
        if (queryCount === 1) return conversations;
        if (queryCount === 2) throw new Error('Corrupt conversation');
        return [
          createMessageRow({ role: 'user', sequenceNumber: 0 }),
          createMessageRow({ role: 'assistant', sequenceNumber: 1 }),
        ];
      });

      const result = await indexer.start(null, 100);

      // Both are counted as processed (error is caught and logged)
      expect(result.processed).toBe(2);
      expect(console.error).toHaveBeenCalled();
    });

    it('should write error state when entire backfill crashes', async () => {
      // Force a crash in the initial conversation query
      mocks.mockDb.queryOne.mockResolvedValueOnce(null);
      mocks.mockDb.query.mockRejectedValueOnce(new Error('Database crash'));

      // updateBackfillState will be called with error
      mocks.mockDb.queryOne.mockResolvedValueOnce(null); // for updateBackfillState check

      const result = await indexer.start(null);

      expect(result).toEqual({ total: 0, processed: 0 });
      expect(console.error).toHaveBeenCalled();

      // Should write error state
      const runCalls = mocks.mockDb.run.mock.calls;
      const errorInsert = runCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('embedding_backfill_state') && (call[1] as unknown[]).includes('error')
      );
      expect(errorInsert).toBeDefined();
    });

    it('should set isRunning to false after crash', async () => {
      mocks.mockDb.queryOne.mockResolvedValueOnce(null);
      mocks.mockDb.query.mockRejectedValueOnce(new Error('Crash'));
      mocks.mockDb.queryOne.mockResolvedValueOnce(null); // for updateBackfillState

      await indexer.start(null);

      expect(indexer.getIsRunning()).toBe(false);
    });
  });
});
