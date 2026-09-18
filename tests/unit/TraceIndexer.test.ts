/**
 * TraceIndexer Unit Tests
 *
 * Tests the backfill indexer for memory traces. Processes traces
 * that don't yet have embedding vectors, with abort/pause support
 * and periodic saves.
 */

import { TraceIndexer, TraceIndexerProgress } from '../../src/services/embeddings/TraceIndexer';
import type { EmbeddingService } from '../../src/services/embeddings/EmbeddingService';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';

// ============================================================================
// Mock Factory
// ============================================================================

function createMockDependencies() {
  const progressCalls: TraceIndexerProgress[] = [];
  const onProgress = jest.fn((progress: TraceIndexerProgress) => {
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
    embedTrace: jest.fn().mockResolvedValue(undefined),
  };

  return { mockDb, mockEmbeddingService, onProgress, progressCalls };
}

function createIndexer(
  mocks: ReturnType<typeof createMockDependencies>,
  saveInterval = 10,
  yieldIntervalMs = 0 // Use 0 for fast tests
) {
  return new TraceIndexer(
    mocks.mockDb as unknown as SQLiteCacheManager,
    mocks.mockEmbeddingService as unknown as EmbeddingService,
    mocks.onProgress,
    saveInterval,
    yieldIntervalMs
  );
}

function createTraceRow(id: string, overrides: Partial<{
  workspaceId: string;
  sessionId: string | null;
  content: string;
}> = {}) {
  return {
    id,
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    content: `Trace content for ${id}`,
    ...overrides,
  };
}

const noOpAsync = async (): Promise<void> => undefined;

// ============================================================================
// Tests
// ============================================================================

describe('TraceIndexer', () => {
  let indexer: TraceIndexer;
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
    it('should return early if embedding service is disabled', async () => {
      mocks.mockEmbeddingService.isServiceEnabled.mockReturnValue(false);

      const result = await indexer.start(null, () => false, noOpAsync);

      expect(result).toEqual({ total: 0, processed: 0 });
      expect(mocks.mockDb.query).not.toHaveBeenCalled();
    });

    it('should return early if no traces need indexing', async () => {
      // All traces already embedded
      mocks.mockDb.query
        .mockResolvedValueOnce([createTraceRow('trace-1')])  // all traces
        .mockResolvedValueOnce([{ traceId: 'trace-1' }]);    // already embedded

      const result = await indexer.start(null, () => false, noOpAsync);

      expect(result).toEqual({ total: 0, processed: 0 });
      expect(mocks.mockEmbeddingService.embedTrace).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Normal Indexing Flow
  // ==========================================================================

  describe('normal indexing flow', () => {
    it('should embed traces that are not yet indexed', async () => {
      const traces = [createTraceRow('trace-1'), createTraceRow('trace-2')];

      mocks.mockDb.query
        .mockResolvedValueOnce(traces)    // all traces
        .mockResolvedValueOnce([]);       // no embedded IDs

      const result = await indexer.start(null, () => false, noOpAsync);

      expect(result.total).toBe(2);
      expect(result.processed).toBe(2);
      expect(mocks.mockEmbeddingService.embedTrace).toHaveBeenCalledTimes(2);
      expect(mocks.mockEmbeddingService.embedTrace).toHaveBeenCalledWith(
        'trace-1', 'ws-1', 'sess-1', 'Trace content for trace-1'
      );
    });

    it('should skip already-embedded traces', async () => {
      const traces = [
        createTraceRow('trace-already'),
        createTraceRow('trace-new'),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(traces)                          // all traces
        .mockResolvedValueOnce([{ traceId: 'trace-already' }]); // already embedded

      const result = await indexer.start(null, () => false, noOpAsync);

      expect(result.total).toBe(1);
      expect(result.processed).toBe(1);
      expect(mocks.mockEmbeddingService.embedTrace).toHaveBeenCalledTimes(1);
      expect(mocks.mockEmbeddingService.embedTrace).toHaveBeenCalledWith(
        'trace-new', 'ws-1', 'sess-1', 'Trace content for trace-new'
      );
    });

    it('should pass undefined for null sessionId', async () => {
      const traces = [createTraceRow('trace-1', { sessionId: null })];

      mocks.mockDb.query
        .mockResolvedValueOnce(traces)    // all traces
        .mockResolvedValueOnce([]);       // no embedded IDs

      await indexer.start(null, () => false, noOpAsync);

      expect(mocks.mockEmbeddingService.embedTrace).toHaveBeenCalledWith(
        'trace-1', 'ws-1', undefined, expect.any(String)
      );
    });
  });

  // ==========================================================================
  // Abort Signal
  // ==========================================================================

  describe('abort signal', () => {
    it('should stop processing when abort signal fires', async () => {
      const abortController = new AbortController();
      const traces = [
        createTraceRow('trace-1'),
        createTraceRow('trace-2'),
        createTraceRow('trace-3'),
      ];

      mocks.mockDb.query
        .mockResolvedValueOnce(traces)    // all traces
        .mockResolvedValueOnce([]);       // no embedded IDs

      // Abort after first embed
      mocks.mockEmbeddingService.embedTrace.mockImplementationOnce(async () => {
        abortController.abort();
      });

      const result = await indexer.start(abortController.signal, () => false, noOpAsync);

      expect(result.processed).toBeLessThan(3);
    });

    it('should set isRunning to false after abort', async () => {
      const abortController = new AbortController();
      abortController.abort(); // Pre-abort

      mocks.mockDb.query
        .mockResolvedValueOnce([createTraceRow('trace-1')])  // all traces
        .mockResolvedValueOnce([]);                          // no embedded IDs

      await indexer.start(abortController.signal, () => false, noOpAsync);

      expect(indexer.getIsRunning()).toBe(false);
    });
  });

  // ==========================================================================
  // Pause / Resume
  // ==========================================================================

  describe('pause and resume', () => {
    it('should call waitForResume when paused', async () => {
      let pauseCount = 0;
      const isPaused = jest.fn(() => {
        pauseCount++;
        return pauseCount <= 1; // Pause on first check only
      });
      const waitForResume = jest.fn().mockResolvedValue(undefined);

      const traces = [createTraceRow('trace-1'), createTraceRow('trace-2')];
      mocks.mockDb.query
        .mockResolvedValueOnce(traces)    // all traces
        .mockResolvedValueOnce([]);       // no embedded IDs

      await indexer.start(null, isPaused, waitForResume);

      expect(waitForResume).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Progress Reporting
  // ==========================================================================

  describe('progress reporting', () => {
    it('should emit initial and final progress', async () => {
      const traces = [createTraceRow('trace-1')];
      mocks.mockDb.query
        .mockResolvedValueOnce(traces)    // all traces
        .mockResolvedValueOnce([]);       // no embedded IDs

      await indexer.start(null, () => false, noOpAsync);

      // Initial + final
      expect(mocks.onProgress).toHaveBeenCalledTimes(2);
      expect(mocks.progressCalls[0]).toEqual({ totalTraces: 1, processedTraces: 0 });
      expect(mocks.progressCalls[1]).toEqual({ totalTraces: 1, processedTraces: 1 });
    });
  });

  // ==========================================================================
  // Periodic Save
  // ==========================================================================

  describe('periodic save', () => {
    it('should save at saveInterval', async () => {
      indexer = createIndexer(mocks, 2, 0);

      const traces = [
        createTraceRow('t-1'), createTraceRow('t-2'), createTraceRow('t-3'),
      ];
      mocks.mockDb.query
        .mockResolvedValueOnce(traces)    // all traces
        .mockResolvedValueOnce([]);       // no embedded IDs

      await indexer.start(null, () => false, noOpAsync);

      // Saves: after 2nd trace (interval) + final save = 2
      expect(mocks.mockDb.save).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Error Resilience
  // ==========================================================================

  describe('error resilience', () => {
    it('should continue when individual trace embedding fails', async () => {
      const traces = [createTraceRow('trace-fail'), createTraceRow('trace-ok')];
      mocks.mockDb.query
        .mockResolvedValueOnce(traces)    // all traces
        .mockResolvedValueOnce([]);       // no embedded IDs

      mocks.mockEmbeddingService.embedTrace
        .mockRejectedValueOnce(new Error('Embed failed'))
        .mockResolvedValueOnce(undefined);

      const result = await indexer.start(null, () => false, noOpAsync);

      // Only trace-ok counted as processed (trace-fail errored before increment)
      expect(result.processed).toBe(1);
      expect(console.error).toHaveBeenCalled();
    });

    it('should propagate error when initial trace query fails (isRunning never set)', async () => {
      mocks.mockDb.query.mockRejectedValueOnce(new Error('Total failure'));

      // The initial query at line 84 is NOT inside try/catch, so it propagates
      await expect(
        indexer.start(null, () => false, noOpAsync)
      ).rejects.toThrow('Total failure');

      // isRunning was never set to true (error happened before line 108)
      expect(indexer.getIsRunning()).toBe(false);
    });
  });
});

/**
 * Phase 0 characterization for docs/plans/sqlite-cache-persistence-plan.md.
 *
 * Unlike the other two call sites, this one is already correct, and that is why
 * it is pinned. `IndexingQueue` lets a failed final save abort the whole run and
 * `ConversationIndexer` lets one wipe its resume checkpoint; `TraceIndexer`
 * swallows both and returns its counts. Three call sites, three behaviours for
 * the same failure.
 *
 * Phase 2 makes the other two behave like this one. These tests exist so that
 * refactor cannot quietly make this one behave like the other two instead.
 *
 * What the fakes decide, and what they do not: `embedTrace` always succeeds,
 * which matches production (`embedTrace()` catches its own failures and never
 * rethrows), and `db.save()` is made to reject. Everything asserted on is the
 * real TraceIndexer.start() loop.
 */
describe('TraceIndexer save path (Phase 0 characterization)', () => {
  function createSaveHarness(traceCount: number, saveInterval: number) {
    const mocks = createMockDependencies();
    const traces = Array.from({ length: traceCount }, (_, i) => createTraceRow(`trace-${i}`));
    mocks.mockDb.query
      .mockResolvedValueOnce(traces)   // all traces
      .mockResolvedValueOnce([]);      // none already embedded
    const indexer = createIndexer(mocks, saveInterval, 0);
    return { mocks, indexer, traces };
  }

  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function loggedMessages(): string[] {
    return errorSpy.mock.calls.map(call => String(call[0]));
  }

  it('keeps embedding traces after a periodic save fails, and finishes the run', async () => {
    const { mocks, indexer } = createSaveHarness(6, 2);
    mocks.mockDb.save.mockRejectedValue(new RangeError('Array buffer allocation failed'));

    const result = await indexer.start(null, () => false, noOpAsync);

    // Every trace was embedded despite three failed periodic saves plus the
    // failed final one. A run that embedded everything and could not write the
    // snapshot is a partial success, not an aborted run.
    expect(mocks.mockEmbeddingService.embedTrace).toHaveBeenCalledTimes(6);
    expect(result).toEqual({ total: 6, processed: 6 });
    expect(indexer.getIsRunning()).toBe(false);

    // And it says what actually failed, naming persistence rather than the
    // trace. This is the wording IndexingQueue does not have.
    const saveFailures = loggedMessages().filter(m => m.includes('Failed to persist embeddings around trace'));
    expect(saveFailures.length).toBeGreaterThan(0);
  });

  it('returns normally when only the final save fails', async () => {
    // Three traces with a save interval of ten: no periodic save fires, so the
    // only save is the final one and the failure is attributable to it.
    const { mocks, indexer } = createSaveHarness(3, 10);
    mocks.mockDb.save.mockRejectedValue(new RangeError('Array buffer allocation failed'));

    const result = await indexer.start(null, () => false, noOpAsync);

    expect(mocks.mockDb.save).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ total: 3, processed: 3 });
    // The outer handler caught it and the progress callback still reported the
    // final count, so the owning queue is not left believing nothing happened.
    expect(loggedMessages().some(m => m.includes('Trace processing failed'))).toBe(true);
    expect(mocks.progressCalls.at(-1)).toEqual({ totalTraces: 3, processedTraces: 3 });
  });
});
