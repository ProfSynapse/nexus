/**
 * EmbeddingManager deferred-start teardown test.
 *
 * initialize() schedules runBackgroundIndexing ~3s later. If the plugin is
 * unloaded inside that window and the timer id is not retained, the callback
 * still fires -- against an EmbeddingManager whose collaborators are already
 * torn down and whose SQLiteCacheManager handle close() has nulled. Every
 * subsequent query then throws "Database not initialized".
 *
 * The IndexingQueue is mocked here on purpose: its own `destroyed` guard would
 * otherwise mask whether the timer was really cancelled, and this test exists to
 * pin the timer specifically.
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
  EmbeddingWatcher: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn()
  }))
}));

jest.mock('../../src/services/embeddings/EmbeddingStatusBar', () => ({
  EmbeddingStatusBar: jest.fn().mockImplementation(() => ({
    init: jest.fn(),
    destroy: jest.fn()
  }))
}));

const startFullIndex = jest.fn().mockResolvedValue(undefined);
const startTraceIndex = jest.fn().mockResolvedValue(undefined);
const startConversationIndex = jest.fn().mockResolvedValue(undefined);
const queueDestroy = jest.fn();

jest.mock('../../src/services/embeddings/IndexingQueue', () => ({
  IndexingQueue: jest.fn().mockImplementation(() => ({
    startFullIndex,
    startTraceIndex,
    startConversationIndex,
    destroy: queueDestroy,
    isIndexing: jest.fn().mockReturnValue(false)
  }))
}));

jest.mock('../../src/services/embeddings/adapter/createRetrievalDreamService', () => ({
  createRetrievalDreamService: jest.fn().mockReturnValue(null)
}));

import { EmbeddingManager } from '../../src/services/embeddings/EmbeddingManager';
import type { App, Plugin } from 'obsidian';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';

function createManager() {
  const app = {
    vault: { adapter: {}, configDir: '.obsidian' }
  } as unknown as App;

  const plugin = {
    settings: { embeddings: { retrievalLearning: false } },
    addCommand: jest.fn(),
    registerInterval: jest.fn()
  } as unknown as Plugin;

  const db = {} as unknown as SQLiteCacheManager;

  return new EmbeddingManager(app, plugin, db, true);
}

describe('EmbeddingManager deferred background indexing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    startFullIndex.mockClear();
    startTraceIndex.mockClear();
    startConversationIndex.mockClear();
    queueDestroy.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not start background indexing when shutdown lands inside the 3s window', async () => {
    const manager = createManager();
    manager.initialize();

    await manager.shutdown();
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();

    expect(queueDestroy).toHaveBeenCalled();
    expect(startFullIndex).not.toHaveBeenCalled();
    expect(startTraceIndex).not.toHaveBeenCalled();
    expect(startConversationIndex).not.toHaveBeenCalled();
  });

  it('still starts background indexing when no shutdown intervenes', async () => {
    const manager = createManager();
    manager.initialize();

    jest.advanceTimersByTime(3_000);
    await Promise.resolve();

    // Conversations are the first phase (cheapest-first ordering), so this is
    // the call that proves the timer fired. Asserting on the note phase would
    // only prove the whole chain had drained.
    expect(startConversationIndex).toHaveBeenCalled();
  });
});
