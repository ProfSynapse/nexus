/**
 * EmbeddingManager phase-ordering and cache-rebuild recovery tests.
 *
 * Two behaviours pinned here:
 *
 *  1. Background indexing runs cheapest-first (conversations -> traces ->
 *     notes). The phases are independent, so the order is free -- and putting
 *     the multi-hour vault walk first means the few hundred conversations
 *     behind it have no chat search until it finishes.
 *  2. A cache rebuild re-derives conversation embeddings. clearAllData() DROPs
 *     conversation_embeddings on every full rebuild and the JSONL replay does
 *     not restore them, so without this a mid-session "Nexus: Rebuild cache"
 *     leaves chat search dead for the rest of the session.
 */

jest.mock('../../src/services/embeddings/EmbeddingEngine', () => ({
  EmbeddingEngine: jest.fn().mockImplementation(() => ({
    dispose: jest.fn().mockResolvedValue(undefined)
  }))
}));

jest.mock('../../src/services/embeddings/EmbeddingService', () => ({
  EmbeddingService: jest.fn().mockImplementation(() => ({
    isServiceEnabled: jest.fn().mockReturnValue(true),
    getStats: jest.fn().mockResolvedValue({ noteCount: 0, traceCount: 0, conversationChunkCount: 0 })
  }))
}));

jest.mock('../../src/services/embeddings/EmbeddingWatcher', () => ({
  EmbeddingWatcher: jest.fn().mockImplementation(() => ({ start: jest.fn(), stop: jest.fn() }))
}));

jest.mock('../../src/services/embeddings/EmbeddingStatusBar', () => ({
  EmbeddingStatusBar: jest.fn().mockImplementation(() => ({ init: jest.fn(), destroy: jest.fn() }))
}));

const calls: string[] = [];
let indexing = false;
const cancel = jest.fn(() => { indexing = false; });

jest.mock('../../src/services/embeddings/IndexingQueue', () => ({
  IndexingQueue: jest.fn().mockImplementation(() => ({
    startFullIndex: jest.fn(async () => { calls.push('notes'); }),
    startTraceIndex: jest.fn(async () => { calls.push('traces'); }),
    startConversationIndex: jest.fn(async () => { calls.push('conversations'); }),
    cancel,
    destroy: jest.fn(),
    isIndexing: jest.fn(() => indexing)
  }))
}));

jest.mock('../../src/services/embeddings/adapter/createRetrievalDreamService', () => ({
  createRetrievalDreamService: jest.fn().mockReturnValue(null)
}));

import { EmbeddingManager } from '../../src/services/embeddings/EmbeddingManager';
import type { App, Plugin } from 'obsidian';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';

function createManager() {
  const app = { vault: { adapter: {}, configDir: '.obsidian' } } as unknown as App;
  const plugin = {
    settings: { embeddings: { retrievalLearning: false } },
    addCommand: jest.fn(),
    registerInterval: jest.fn()
  } as unknown as Plugin;
  return new EmbeddingManager(app, plugin, {} as unknown as SQLiteCacheManager, true);
}

describe('EmbeddingManager background indexing order', () => {
  beforeEach(() => {
    calls.length = 0;
    indexing = false;
    cancel.mockClear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('indexes conversations before traces, and notes last', async () => {
    const manager = createManager();
    manager.initialize();

    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(['conversations', 'traces', 'notes']);
  });

  it('re-derives embeddings after a cache rebuild', async () => {
    jest.useRealTimers();
    const manager = createManager();
    manager.initialize();
    calls.length = 0;

    await manager.reindexAfterCacheRebuild();

    // Conversations first here too: they are the rows the rebuild actually
    // destroyed, so they must not queue behind the vault walk.
    expect(calls[0]).toBe('conversations');
    expect(calls).toContain('traces');
    expect(calls).toContain('notes');
  });

  it('cancels the in-flight walk so the re-index is not swallowed by isRunning', async () => {
    jest.useRealTimers();
    const manager = createManager();
    manager.initialize();
    indexing = true;          // the long note walk is running
    calls.length = 0;

    await manager.reindexAfterCacheRebuild();

    // Without the cancel(), every phase would early-return on isRunning and the
    // rebuild would silently leave conversation embeddings at zero.
    expect(cancel).toHaveBeenCalled();
    expect(calls[0]).toBe('conversations');
  });
});
