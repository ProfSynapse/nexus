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
        .mockImplementationOnce(() => new Promise(() => undefined)); // block on messages query

      // Start first run (will block)
      const firstRun = indexer.start(null, 100);
      void firstRun;

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

/**
 * Phase 0 characterization for docs/plans/sqlite-cache-persistence-plan.md,
 * section 6b. No production code changes with this; it pins what the code does
 * today so Phase 2 has to turn a red test green.
 *
 * The defect: the final `db.save()` is inside the outer try. When it throws,
 * the handler writes `lastProcessedConversationId: null` and
 * `processedConversations: 0`. The resume logic keys entirely off
 * `lastProcessedConversationId`, so the next launch restarts the backfill at
 * conversation zero and re-embeds every conversation in the vault at full API
 * cost. On the machine that motivated the plan the save is exactly the thing
 * that keeps failing, so this is not hypothetical.
 *
 * What the fake decides, and what it does not: the db here is STATEFUL. It
 * really stores the `embedding_backfill_state` row that `updateBackfillState`
 * writes and really hands it back to the next run's resume query. That is the
 * whole point: an assertion that a field was written proves nothing, because
 * the damage is what the next run does with it. The resume decision, the
 * restart, and the re-embedding are all the real ConversationIndexer.
 */
describe('ConversationIndexer resume checkpoint (Phase 0 characterization)', () => {
  interface StoredBackfillState {
    id: string;
    lastProcessedConversationId: string | null;
    totalConversations: number;
    processedConversations: number;
    status: string;
    startedAt: number | null;
    completedAt: number | null;
    errorMessage: string | null;
  }

  /**
   * A db fake that persists the one table this behaviour turns on, so a second
   * run reads back what the first run actually wrote.
   */
  function createStatefulDb(conversationIds: string[]) {
    let state: StoredBackfillState | null = null;
    const save = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    /** Conversation ids whose messages were fetched, in order, across all runs. */
    const messageFetches: string[] = [];

    const conversations = conversationIds.map(id => ({
      id,
      metadataJson: null,
      workspaceId: 'ws-1',
      sessionId: 'sess-1'
    }));

    const db = {
      queryOne: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT * FROM embedding_backfill_state')) {
          return state ? { ...state } : null;
        }
        if (sql.includes('SELECT id FROM embedding_backfill_state')) {
          return state ? { id: state.id } : null;
        }
        return null;
      }),
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM conversations')) {
          return conversations.map(c => ({ ...c }));
        }
        if (sql.includes('FROM messages')) {
          const conversationId = String(params?.[0] ?? '');
          messageFetches.push(conversationId);
          return [
            { ...createMessageRow({ id: `${conversationId}-m0`, conversationId, role: 'user', sequenceNumber: 0 }) },
            { ...createMessageRow({ id: `${conversationId}-m1`, conversationId, role: 'assistant', sequenceNumber: 1 }) }
          ];
        }
        return [];
      }),
      run: jest.fn(async (sql: string, params?: unknown[]) => {
        const values = params ?? [];
        if (sql.includes('UPDATE embedding_backfill_state')) {
          state = {
            id: String(values[6]),
            lastProcessedConversationId: values[0] as string | null,
            totalConversations: values[1] as number,
            processedConversations: values[2] as number,
            status: String(values[3]),
            startedAt: state?.startedAt ?? null,
            completedAt: values[4] as number | null,
            errorMessage: values[5] as string | null
          };
        } else if (sql.includes('INSERT INTO embedding_backfill_state')) {
          state = {
            id: String(values[0]),
            lastProcessedConversationId: values[1] as string | null,
            totalConversations: values[2] as number,
            processedConversations: values[3] as number,
            status: String(values[4]),
            startedAt: values[5] as number | null,
            completedAt: values[6] as number | null,
            errorMessage: values[7] as string | null
          };
        }
        return undefined;
      }),
      save
    };

    return {
      db,
      save,
      messageFetches,
      readState: () => state,
      seedState: (seed: Partial<StoredBackfillState>) => {
        state = {
          id: 'conversation_backfill',
          lastProcessedConversationId: null,
          totalConversations: conversationIds.length,
          processedConversations: 0,
          status: 'running',
          startedAt: Date.now(),
          completedAt: null,
          errorMessage: null,
          ...seed
        };
      }
    };
  }

  function createIndexerOn(
    stateful: ReturnType<typeof createStatefulDb>,
    saveInterval = 100
  ) {
    const embeddingService = {
      isServiceEnabled: jest.fn().mockReturnValue(true),
      embedConversationTurn: jest.fn().mockResolvedValue(undefined)
    };
    const indexer = new ConversationIndexer(
      stateful.db as unknown as SQLiteCacheManager,
      embeddingService as unknown as EmbeddingService,
      jest.fn(),
      saveInterval
    );
    return { indexer, embeddingService };
  }

  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  // PHASE 2 INVERTS THIS. Option B's third item: a failing save must preserve
  // `lastProcessedConversationId` and `processedConversations` so the resume at
  // ConversationIndexer:153-161 still works. This is described in the plan as
  // the highest-value single line in the document measured in dollars of
  // re-embedding.
  it('nulls the resume checkpoint when the final save fails, so the next run restarts at zero', async () => {
    const stateful = createStatefulDb(['conv-1', 'conv-2', 'conv-3']);

    // Run one: every conversation is embedded, then the snapshot cannot be
    // written. saveInterval is above the conversation count, so the only save
    // is the final one.
    const first = createIndexerOn(stateful);
    stateful.save.mockRejectedValue(new RangeError('Array buffer allocation failed'));
    await first.indexer.start(null, 100);

    expect(first.embeddingService.embedConversationTurn).toHaveBeenCalled();
    expect(stateful.messageFetches).toEqual(['conv-1', 'conv-2', 'conv-3']);

    // The checkpoint the next run needs has been overwritten with nothing.
    const afterFailure = stateful.readState();
    expect(afterFailure?.status).toBe('error');
    expect(afterFailure?.lastProcessedConversationId).toBeNull();
    expect(afterFailure?.processedConversations).toBe(0);

    // The consequence, which is the part that costs money. Run two reads that
    // checkpoint back through the real resume path and starts from the top.
    stateful.messageFetches.length = 0;
    stateful.save.mockResolvedValue(undefined);
    const second = createIndexerOn(stateful);
    const result = await second.indexer.start(null, 100);

    expect(stateful.messageFetches).toEqual(['conv-1', 'conv-2', 'conv-3']);
    expect(result).toEqual({ total: 3, processed: 3 });
  });

  // The control that makes the test above mean something. The resume path is
  // live and works: with a checkpoint intact, the next run skips what was
  // already done. So the restart above is caused by the null and by nothing
  // else, and preserving the checkpoint in Phase 2 is sufficient to fix it.
  it('resumes after the checkpoint when a failed run left one intact', async () => {
    const stateful = createStatefulDb(['conv-1', 'conv-2', 'conv-3']);
    stateful.seedState({
      status: 'error',
      lastProcessedConversationId: 'conv-1',
      processedConversations: 1,
      errorMessage: 'Array buffer allocation failed'
    });

    const { indexer } = createIndexerOn(stateful);
    const result = await indexer.start(null, 100);

    // conv-1 is not re-embedded.
    expect(stateful.messageFetches).toEqual(['conv-2', 'conv-3']);
    expect(result).toEqual({ total: 3, processed: 3 });
    expect(stateful.readState()?.status).toBe('completed');
  });
});
