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

      const result = await indexer.start(null, () => false, async () => {});

      expect(result).toEqual({ total: 0, processed: 0 });
      expect(mocks.mockDb.query).not.toHaveBeenCalled();
    });

    it('should return early if no traces need indexing', async () => {
      // All traces already embedded
      mocks.mockDb.query
        .mockResolvedValueOnce([createTraceRow('trace-1')])  // all traces
        .mockResolvedValueOnce([{ traceId: 'trace-1' }]);    // already embedded

      const result = await indexer.start(null, () => false, async () => {});

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

      const result = await indexer.start(null, () => false, async () => {});

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

      const result = await indexer.start(null, () => false, async () => {});

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

      await indexer.start(null, () => false, async () => {});

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

      const result = await indexer.start(abortController.signal, () => false, async () => {});

      expect(result.processed).toBeLessThan(3);
    });

    it('should set isRunning to false after abort', async () => {
      const abortController = new AbortController();
      abortController.abort(); // Pre-abort

      mocks.mockDb.query
        .mockResolvedValueOnce([createTraceRow('trace-1')])  // all traces
        .mockResolvedValueOnce([]);                          // no embedded IDs

      await indexer.start(abortController.signal, () => false, async () => {});

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

      await indexer.start(null, () => false, async () => {});

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

      await indexer.start(null, () => false, async () => {});

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

      const result = await indexer.start(null, () => false, async () => {});

      // Only trace-ok counted as processed (trace-fail errored before increment)
      expect(result.processed).toBe(1);
      expect(console.error).toHaveBeenCalled();
    });

    it('should propagate error when initial trace query fails (isRunning never set)', async () => {
      mocks.mockDb.query.mockRejectedValueOnce(new Error('Total failure'));

      // The initial query at line 84 is NOT inside try/catch, so it propagates
      await expect(
        indexer.start(null, () => false, async () => {})
      ).rejects.toThrow('Total failure');

      // isRunning was never set to true (error happened before line 108)
      expect(indexer.getIsRunning()).toBe(false);
    });
  });
});
