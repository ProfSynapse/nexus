/**
 * Semantic search turns off and on without a restart.
 *
 * Before this, `enableEmbeddings` was read once at startup: initialize()
 * returned early when it was off, and nothing reacted to a later change. The
 * dream-cycle interval and the "dream now" command were registered in a way
 * that could not be undone, and getStats() reported zeros while off, so the
 * settings fold could not show how much index it was keeping.
 *
 * What is real: EmbeddingManager. What is faked: its components (engine,
 * service, watchers, queue, status bar, dream service) as constructor spies
 * that record what the manager asks of them, and a database stub that answers
 * the four count queries. The manager's own state, ordering and teardown are
 * what is measured.
 */

interface FakeComponent {
  id: number;
  [key: string]: unknown;
}

const created: Record<string, FakeComponent[]> = {
  engine: [], service: [], watcher: [], conversationWatcher: [], queue: [], statusBar: []
};

function track<T extends FakeComponent>(kind: string, make: (id: number) => T): T {
  const component = make(created[kind].length + 1);
  created[kind].push(component);
  return component;
}

jest.mock('../../src/services/embeddings/EmbeddingEngine', () => ({
  EmbeddingEngine: jest.fn().mockImplementation(() => track('engine', id => ({
    id, dispose: jest.fn().mockResolvedValue(undefined)
  })))
}));

jest.mock('../../src/services/embeddings/EmbeddingService', () => ({
  EmbeddingService: jest.fn().mockImplementation(() => track('service', id => ({
    id, isServiceEnabled: jest.fn().mockReturnValue(true), disable: jest.fn()
  })))
}));

jest.mock('../../src/services/embeddings/EmbeddingWatcher', () => ({
  EmbeddingWatcher: jest.fn().mockImplementation(() => track('watcher', id => ({
    id, start: jest.fn(), stop: jest.fn()
  })))
}));

jest.mock('../../src/services/embeddings/ConversationEmbeddingWatcher', () => ({
  ConversationEmbeddingWatcher: jest.fn().mockImplementation(() => track('conversationWatcher', id => ({
    id, start: jest.fn(), shutdown: jest.fn().mockResolvedValue(undefined)
  })))
}));

jest.mock('../../src/services/embeddings/EmbeddingStatusBar', () => ({
  EmbeddingStatusBar: jest.fn().mockImplementation(() => track('statusBar', id => ({
    id, init: jest.fn(), destroy: jest.fn()
  })))
}));

jest.mock('../../src/services/embeddings/IndexingQueue', () => {
  // A real Events bus, so progress relayed by the manager is the queue's own.
  const { Events } = jest.requireActual('obsidian');
  return {
    IndexingQueue: jest.fn().mockImplementation(() => track('queue', id => {
      const bus = new Events();
      let paused = false;
      return Object.assign(bus, {
        id,
        pruneMissingNotes: jest.fn().mockResolvedValue(0),
        pruneMissingConversations: jest.fn().mockResolvedValue(0),
        startConversationIndex: jest.fn().mockResolvedValue(undefined),
        startTraceIndex: jest.fn().mockResolvedValue(undefined),
        startFullIndex: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn(),
        cancel: jest.fn(),
        isIndexing: jest.fn(() => true),
        isIndexingPaused: jest.fn(() => paused),
        pause: jest.fn(() => { paused = true; }),
        resume: jest.fn(() => { paused = false; }),
        getProgress: jest.fn(() => ({
          phase: paused ? 'paused' : 'indexing', totalNotes: 10, processedNotes: 4,
          currentNote: null, estimatedTimeRemaining: 30
        }))
      });
    }))
  };
});

const loadAndApply = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/embeddings/adapter/createRetrievalDreamService', () => ({
  createRetrievalDreamService: jest.fn(() => ({ loadAndApply, dream: { runDreamCycle: jest.fn() } }))
}));

import { EmbeddingManager, type EmbeddingRuntimeStatus } from '../../src/services/embeddings/EmbeddingManager';
import type { App, Plugin } from 'obsidian';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import type { MessageRepository } from '../../src/database/repositories/MessageRepository';

const COUNTS: Record<string, number> = {
  'SELECT COUNT(*) as count FROM embedding_metadata': 4512,
  'SELECT COUNT(*) as count FROM trace_embedding_metadata': 77,
  'SELECT COUNT(*) as count FROM conversation_embedding_metadata': 2400,
  'SELECT COUNT(DISTINCT conversationId) as count FROM conversation_embedding_metadata': 318
};

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function createManager(enabled = true) {
  const app = { vault: { adapter: { exists: jest.fn(), read: jest.fn(), write: jest.fn() }, configDir: '.obsidian' } } as unknown as App;
  const plugin = {
    settings: { embeddings: { retrievalLearning: true } },
    addCommand: jest.fn(),
    removeCommand: jest.fn(),
    registerInterval: jest.fn((id: number) => id)
  };
  const db = {
    queryOne: jest.fn(async (sql: string) => (sql in COUNTS ? { count: COUNTS[sql] } : null)),
    clearEmbeddingIndex: jest.fn().mockResolvedValue(undefined)
  };
  const manager = new EmbeddingManager(
    app,
    plugin as unknown as Plugin,
    db as unknown as SQLiteCacheManager,
    enabled,
    {} as MessageRepository
  );
  const states: EmbeddingRuntimeStatus[] = [];
  manager.onStateChange(status => states.push(status));
  return { manager, plugin, db, app, states };
}

describe('EmbeddingManager hot toggle', () => {
  let clearIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    for (const list of Object.values(created)) list.length = 0;
    clearIntervalSpy = jest.spyOn(window, 'clearInterval');
  });

  afterEach(() => {
    clearIntervalSpy.mockRestore();
    jest.useRealTimers();
  });

  it('setEnabled(false) stops every component, clears the dream cycle and reports it', async () => {
    const h = createManager();
    h.manager.initialize();
    const dreamInterval = h.plugin.registerInterval.mock.calls[0][0];
    const [engine] = created.engine;
    const [watcher] = created.watcher;
    const [conversationWatcher] = created.conversationWatcher;
    const [queue] = created.queue;
    const [statusBar] = created.statusBar;
    h.states.length = 0;

    await h.manager.setEnabled(false);

    expect(watcher.stop).toHaveBeenCalled();
    expect(conversationWatcher.shutdown).toHaveBeenCalled();
    expect(queue.destroy).toHaveBeenCalled();
    expect(statusBar.destroy).toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalled();
    // Holders of the old service get disabled answers, so they cannot wake the engine.
    expect(created.service[0].disable).toHaveBeenCalled();
    expect((created.service[0].disable as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((engine.dispose as jest.Mock).mock.invocationCallOrder[0]);
    expect(clearIntervalSpy).toHaveBeenCalledWith(dreamInterval);
    expect(h.plugin.removeCommand).toHaveBeenCalledWith('consolidate-retrieval-memory');
    expect(h.manager.getService()).toBeNull();
    expect(h.manager.isEmbeddingEnabled()).toBe(false);
    expect(h.states.at(-1)).toMatchObject({ enabled: false, initialized: false });

    // The deferred indexing kick-off was cancelled with everything else.
    jest.advanceTimersByTime(10_000);
    await flushMicrotasks();
    expect(queue.startConversationIndex).not.toHaveBeenCalled();
  });

  it('setEnabled(true) builds fresh components and schedules indexing, prune first', async () => {
    const h = createManager();
    h.manager.initialize();
    const firstService = h.manager.getService();
    await h.manager.setEnabled(false);

    await h.manager.setEnabled(true);

    expect(created.engine).toHaveLength(2);
    expect(created.queue).toHaveLength(2);
    expect(h.manager.getService()).not.toBeNull();
    expect(h.manager.getService()).not.toBe(firstService);
    expect(h.manager.isEmbeddingEnabled()).toBe(true);
    expect(h.plugin.addCommand).toHaveBeenCalledTimes(2);
    expect(h.states.at(-1)).toMatchObject({ enabled: true, initialized: true });

    const queue = created.queue[1];
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(queue.pruneMissingNotes).toHaveBeenCalled();
    expect(queue.startConversationIndex).toHaveBeenCalled();
    expect((queue.pruneMissingNotes as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((queue.startConversationIndex as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('starts a manager that was constructed turned off', async () => {
    const h = createManager(false);
    h.manager.initialize();
    expect(created.engine).toHaveLength(0);

    await h.manager.setEnabled(true);

    expect(created.engine).toHaveLength(1);
    expect(h.manager.isEmbeddingEnabled()).toBe(true);
  });

  it('is idempotent: repeating the current state rebuilds nothing', async () => {
    const h = createManager();
    h.manager.initialize();

    await h.manager.setEnabled(true);
    await h.manager.setEnabled(true);

    expect(created.engine).toHaveLength(1);
  });

  it('reports a failed start to the caller, and turning on again retries', async () => {
    const h = createManager(false);
    const { EmbeddingStatusBar } = jest.requireMock('../../src/services/embeddings/EmbeddingStatusBar');
    (EmbeddingStatusBar as jest.Mock).mockImplementationOnce(() => { throw new Error('status bar failed'); });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(h.manager.setEnabled(true)).rejects.toThrow('could not start');
      // The half-built components were stopped and dropped.
      expect(created.watcher[0].stop).toHaveBeenCalled();
      expect(created.engine[0].dispose).toHaveBeenCalled();
      expect(h.manager.getService()).toBeNull();
      expect(h.states.at(-1)).toMatchObject({ enabled: true, initialized: false });
      // Why it failed stays readable, so search can say so instead of
      // "still initializing" (resolveSemanticSearchState reads this).
      expect(h.manager.getStatus().startError).toBe('status bar failed');

      await h.manager.setEnabled(true);
      expect(created.engine).toHaveLength(2);
      expect(h.states.at(-1)).toMatchObject({ enabled: true, initialized: true, startError: null });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a failed toggle does not block the next one', async () => {
    const h = createManager();
    h.manager.initialize();
    const [engine] = created.engine;
    (engine.dispose as jest.Mock).mockRejectedValueOnce(new Error('dispose failed'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(h.manager.setEnabled(false)).rejects.toThrow('dispose failed');
      await h.manager.setEnabled(true);
      expect(created.engine).toHaveLength(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('stops a background chain between phases when turned off mid-run', async () => {
    const h = createManager();
    h.manager.initialize();
    const [queue] = created.queue;
    let finishConversations!: () => void;
    (queue.startConversationIndex as jest.Mock).mockImplementationOnce(
      () => new Promise<void>(resolve => { finishConversations = resolve; })
    );
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(queue.startConversationIndex).toHaveBeenCalled();

    const stopping = h.manager.setEnabled(false);
    await flushMicrotasks();
    finishConversations();
    await stopping;

    expect(queue.startTraceIndex).not.toHaveBeenCalled();
    expect(queue.startFullIndex).not.toHaveBeenCalled();
  });

  it('a later shutdown() after a toggle does not throw and blocks further starts', async () => {
    const h = createManager();
    h.manager.initialize();
    await h.manager.setEnabled(false);
    await h.manager.setEnabled(true);

    await expect(h.manager.shutdown()).resolves.toBeUndefined();
    await h.manager.setEnabled(false);
    await h.manager.setEnabled(true);

    expect(created.engine).toHaveLength(2);
    expect(h.manager.getService()).toBeNull();
  });

  it('relays queue progress, and pause/resume, to state subscribers', async () => {
    const h = createManager();
    h.manager.initialize();
    const [queue] = created.queue;
    h.states.length = 0;

    const progress = { phase: 'indexing', totalNotes: 10, processedNotes: 4, currentNote: 'a.md', estimatedTimeRemaining: 30 };
    (queue as unknown as { trigger(name: string, data: unknown): void }).trigger('progress', progress);
    expect(h.states.at(-1)?.progress).toEqual(progress);

    h.manager.pauseIndexing();
    expect(queue.pause).toHaveBeenCalled();
    expect(h.states.at(-1)?.paused).toBe(true);

    h.manager.resumeIndexing();
    expect(queue.resume).toHaveBeenCalled();
    expect(h.states.at(-1)?.paused).toBe(false);

    // After a stop the old queue's events no longer reach subscribers.
    await h.manager.setEnabled(false);
    h.states.length = 0;
    (queue as unknown as { trigger(name: string, data: unknown): void }).trigger('progress', progress);
    expect(h.states).toEqual([]);
  });

  it('retry() starts over from fresh components after the model failed to load', async () => {
    const h = createManager();
    h.manager.initialize();
    const [queue] = created.queue;
    const [engine] = created.engine;
    const failed = {
      phase: 'error', totalNotes: 7, processedNotes: 0, currentNote: null,
      estimatedTimeRemaining: null, error: 'The embedding model could not be loaded'
    };
    (queue as unknown as { trigger(name: string, data: unknown): void }).trigger('progress', failed);
    expect(h.manager.getStatus().progress?.phase).toBe('error');
    // The manager still counts as running, so turning on again does nothing.
    await h.manager.setEnabled(true);
    expect(created.engine).toHaveLength(1);

    await h.manager.retry();

    expect(engine.dispose).toHaveBeenCalled();
    expect(created.engine).toHaveLength(2);
    expect(created.queue).toHaveLength(2);
    expect(h.manager.getStatus()).toMatchObject({ enabled: true, initialized: true, progress: null });
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(created.queue[1].startFullIndex).toHaveBeenCalled();
  });

  it('retry() does nothing while semantic search is turned off', async () => {
    const h = createManager(false);
    await h.manager.retry();
    expect(created.engine).toHaveLength(0);
    expect(h.manager.isEmbeddingEnabled()).toBe(false);
  });

  it('unsubscribes a state listener', async () => {
    const h = createManager();
    const seen: EmbeddingRuntimeStatus[] = [];
    const unsubscribe = h.manager.onStateChange(status => seen.push(status));
    unsubscribe();

    h.manager.initialize();
    await h.manager.setEnabled(false);

    expect(seen).toEqual([]);
  });
});

describe('EmbeddingManager stats and index deletion', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    for (const list of Object.values(created)) list.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports the stored index while turned off, including distinct chats', async () => {
    const h = createManager(false);

    const stats = await h.manager.getStats();

    expect(stats).toMatchObject({
      enabled: false,
      initialized: false,
      noteCount: 4512,
      traceCount: 77,
      conversationChunkCount: 2400,
      conversationCount: 318,
      indexingInProgress: false
    });
  });

  it('reports zero for a count the database cannot answer', async () => {
    const h = createManager(false);
    h.db.queryOne.mockRejectedValueOnce(new Error('Database not initialized'));

    const stats = await h.manager.getStats();

    expect(stats.noteCount).toBe(0);
    expect(stats.conversationCount).toBe(318);
  });

  it('refuses to delete the index while semantic search is on', async () => {
    const h = createManager();
    h.manager.initialize();

    await expect(h.manager.deleteIndex()).rejects.toThrow(/off/);
    expect(h.db.clearEmbeddingIndex).not.toHaveBeenCalled();

    // A refused delete must not wedge later toggles.
    await h.manager.setEnabled(false);
    expect(h.manager.getService()).toBeNull();
  });

  it('deletes vectors only while off, keeps the adapter file, and reports the change', async () => {
    const h = createManager();
    h.manager.initialize();
    await h.manager.setEnabled(false);
    h.states.length = 0;

    await h.manager.deleteIndex();

    expect(h.db.clearEmbeddingIndex).toHaveBeenCalledTimes(1);
    const adapterFs = (h.app.vault as unknown as { adapter: Record<string, jest.Mock> }).adapter;
    expect(adapterFs.write).not.toHaveBeenCalled();
    expect(h.states).toHaveLength(1);
    expect(h.states[0]).toMatchObject({ enabled: false });
  });

  it('waits for a pending turn-off before deleting', async () => {
    const h = createManager();
    h.manager.initialize();

    const off = h.manager.setEnabled(false);
    const deleted = h.manager.deleteIndex();
    await off;
    await expect(deleted).resolves.toBeUndefined();
    expect(h.db.clearEmbeddingIndex).toHaveBeenCalledTimes(1);
  });
});
