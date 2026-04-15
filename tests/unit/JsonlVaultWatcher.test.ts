/**
 * Tests for JsonlVaultWatcher — verifies vault-event-driven JSONL change
 * detection, debouncing, and self-write suppression.
 */

import { TFile } from 'obsidian';
import {
  JsonlVaultWatcher,
  ModifiedStream,
  parseStreamPath
} from '../../src/database/sync/JsonlVaultWatcher';

/**
 * Minimal Obsidian-like app stub exposing just the `vault.on()` /
 * `vault.offref()` surface the watcher uses. Event callbacks are stored
 * by event name so tests can fire synthetic events at will.
 */
type VaultEvent = 'modify' | 'create' | 'delete' | 'rename';
type EventHandler = (...args: unknown[]) => void;

function createMockApp() {
  const handlers = new Map<VaultEvent, Set<EventHandler>>([
    ['modify', new Set()],
    ['create', new Set()],
    ['delete', new Set()],
    ['rename', new Set()]
  ]);

  const offref = jest.fn((ref: unknown) => {
    const r = ref as { _event: VaultEvent; _fn: EventHandler };
    handlers.get(r._event)?.delete(r._fn);
  });

  const on = jest.fn((event: VaultEvent, fn: EventHandler) => {
    handlers.get(event)?.add(fn);
    return { _event: event, _fn: fn };
  });

  const fire = (event: VaultEvent, ...args: unknown[]) => {
    for (const fn of handlers.get(event) ?? []) {
      fn(...args);
    }
  };

  return {
    app: {
      vault: { on, offref }
    },
    fire,
    handlers
  };
}

function makeTFile(path: string): TFile {
  const file = Object.create(TFile.prototype);
  const name = path.split('/').pop() ?? path;
  file.path = path;
  file.name = name;
  file.basename = name.replace(/\.[^/.]+$/, '');
  file.extension = name.split('.').pop() ?? '';
  return file;
}

describe('parseStreamPath', () => {
  it('parses sharded conversation paths', () => {
    expect(parseStreamPath('conversations/conv_abc-123/shard-000.jsonl')).toEqual({
      category: 'conversations',
      streamId: 'conv_abc-123',
      businessId: 'abc-123'
    });
  });

  it('parses flat conversation paths (legacy layout)', () => {
    expect(parseStreamPath('conversations/conv_abc-123.jsonl')).toEqual({
      category: 'conversations',
      streamId: 'conv_abc-123',
      businessId: 'abc-123'
    });
  });

  it('parses sharded workspace paths and strips ws_ prefix', () => {
    expect(parseStreamPath('workspaces/ws_work-1/shard-002.jsonl')).toEqual({
      category: 'workspaces',
      streamId: 'ws_work-1',
      businessId: 'work-1'
    });
  });

  it('parses task paths and strips tasks_ prefix', () => {
    expect(parseStreamPath('tasks/tasks_work-1/shard-000.jsonl')).toEqual({
      category: 'tasks',
      streamId: 'tasks_work-1',
      businessId: 'work-1'
    });
  });

  it('returns null for unrelated paths', () => {
    expect(parseStreamPath('conversations/_meta/storage-manifest.json')).toBeNull();
    expect(parseStreamPath('some/other/file.jsonl')).toBeNull();
    expect(parseStreamPath('conversations/not-a-shard.txt')).toBeNull();
  });
});

describe('JsonlVaultWatcher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function build(overrides: { debounceMs?: number; suppressTtlMs?: number } = {}) {
    const onChange = jest.fn().mockResolvedValue(undefined);
    const { app, fire } = createMockApp();
    const watcher = new JsonlVaultWatcher({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app: app as any,
      dataPath: 'Nexus/data',
      onChange,
      debounceMs: overrides.debounceMs ?? 100,
      suppressTtlMs: overrides.suppressTtlMs ?? 500
    });
    return { watcher, fire, onChange };
  }

  it('registers vault listeners on start and releases them on stop', () => {
    const onChange = jest.fn();
    const { app } = createMockApp();
    const watcher = new JsonlVaultWatcher({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app: app as any,
      dataPath: 'Nexus/data',
      onChange
    });

    watcher.start();
    expect(app.vault.on).toHaveBeenCalledTimes(4);

    watcher.stop();
    expect(app.vault.offref).toHaveBeenCalledTimes(4);
  });

  it('fires onChange for a modified JSONL shard after debounce', async () => {
    const { watcher, fire, onChange } = build({ debounceMs: 100 });
    watcher.start();

    fire('modify', makeTFile('Nexus/data/conversations/conv_abc/shard-000.jsonl'));
    expect(onChange).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    const modified: ModifiedStream[] = onChange.mock.calls[0][0];
    expect(modified).toHaveLength(1);
    expect(modified[0]).toMatchObject({
      category: 'conversations',
      streamId: 'conv_abc',
      businessId: 'abc'
    });
  });

  it('ignores files outside the data path', async () => {
    const { watcher, fire, onChange } = build();
    watcher.start();

    fire('modify', makeTFile('Unrelated/conv_abc/shard-000.jsonl'));
    fire('modify', makeTFile('Daily Notes/2026-04-15.md'));

    await jest.advanceTimersByTimeAsync(500);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores non-jsonl files inside the data path', async () => {
    const { watcher, fire, onChange } = build();
    watcher.start();

    fire('modify', makeTFile('Nexus/data/_meta/storage-manifest.json'));

    await jest.advanceTimersByTimeAsync(500);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('debounces bursts of modifies into a single onChange call', async () => {
    const { watcher, fire, onChange } = build({ debounceMs: 100 });
    watcher.start();

    for (let i = 0; i < 5; i++) {
      fire('modify', makeTFile(`Nexus/data/conversations/conv_${i}/shard-000.jsonl`));
    }
    await jest.advanceTimersByTimeAsync(100);

    expect(onChange).toHaveBeenCalledTimes(1);
    const modified: ModifiedStream[] = onChange.mock.calls[0][0];
    expect(modified).toHaveLength(5);
  });

  it('deduplicates the same stream modified multiple times in one window', async () => {
    const { watcher, fire, onChange } = build({ debounceMs: 100 });
    watcher.start();

    // Two writes to different shards of the same logical stream
    fire('modify', makeTFile('Nexus/data/conversations/conv_abc/shard-000.jsonl'));
    fire('modify', makeTFile('Nexus/data/conversations/conv_abc/shard-001.jsonl'));
    fire('modify', makeTFile('Nexus/data/conversations/conv_abc/shard-000.jsonl'));

    await jest.advanceTimersByTimeAsync(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toHaveLength(1);
  });

  it('suppresses echoes from self-writes via suppressLogicalPath', async () => {
    const { watcher, fire, onChange } = build({ debounceMs: 100 });
    watcher.start();

    // Plugin is about to write — suppress imminent modify events.
    watcher.suppressLogicalPath('conversations/conv_abc.jsonl');

    // The physical shard write lands. It's suppressed; no dispatch.
    fire('modify', makeTFile('Nexus/data/conversations/conv_abc/shard-000.jsonl'));

    await jest.advanceTimersByTimeAsync(100);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('suppresses all events within TTL window (e.g. shard rotation)', async () => {
    const { watcher, fire, onChange } = build({ debounceMs: 100, suppressTtlMs: 500 });
    watcher.start();

    watcher.suppressLogicalPath('conversations/conv_abc.jsonl');

    // Both modifies (e.g. shard rotation producing two vault events) are
    // suppressed within the TTL window — no needless sync triggered.
    fire('modify', makeTFile('Nexus/data/conversations/conv_abc/shard-000.jsonl'));
    fire('modify', makeTFile('Nexus/data/conversations/conv_abc/shard-001.jsonl'));

    await jest.advanceTimersByTimeAsync(100);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('expires suppression after TTL', async () => {
    const { watcher, fire, onChange } = build({ debounceMs: 50, suppressTtlMs: 100 });
    watcher.start();

    watcher.suppressLogicalPath('conversations/conv_abc.jsonl');
    await jest.advanceTimersByTimeAsync(200); // past TTL

    fire('modify', makeTFile('Nexus/data/conversations/conv_abc/shard-000.jsonl'));
    await jest.advanceTimersByTimeAsync(50);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('still fires onChange for remote streams even if another was suppressed', async () => {
    const { watcher, fire, onChange } = build({ debounceMs: 100 });
    watcher.start();

    watcher.suppressLogicalPath('conversations/conv_self.jsonl');
    fire('modify', makeTFile('Nexus/data/conversations/conv_self/shard-000.jsonl'));
    fire('modify', makeTFile('Nexus/data/conversations/conv_remote/shard-000.jsonl'));

    await jest.advanceTimersByTimeAsync(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    const modified: ModifiedStream[] = onChange.mock.calls[0][0];
    expect(modified).toHaveLength(1);
    expect(modified[0].streamId).toBe('conv_remote');
  });

  it('queues a follow-up dispatch when changes land during an ongoing onChange', async () => {
    const onChange = jest.fn<Promise<void>, [ModifiedStream[]]>();
    const { app, fire } = createMockApp();
    const watcher = new JsonlVaultWatcher({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app: app as any,
      dataPath: 'Nexus/data',
      onChange,
      debounceMs: 50,
      suppressTtlMs: 1000
    });

    // First onChange resolves only when we tell it to.
    let resolveFirst: (() => void) | undefined;
    onChange.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveFirst = resolve; })
    );
    onChange.mockImplementationOnce(() => Promise.resolve());

    watcher.start();

    fire('modify', makeTFile('Nexus/data/conversations/conv_a/shard-000.jsonl'));
    await jest.advanceTimersByTimeAsync(50);
    expect(onChange).toHaveBeenCalledTimes(1);

    // While first dispatch is in-flight, a new change lands.
    fire('modify', makeTFile('Nexus/data/conversations/conv_b/shard-000.jsonl'));
    await jest.advanceTimersByTimeAsync(50);

    // Second dispatch shouldn't run yet — first is still pending.
    expect(onChange).toHaveBeenCalledTimes(1);

    // Complete first, follow-up should dispatch.
    resolveFirst?.();
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(50);

    expect(onChange).toHaveBeenCalledTimes(2);
    const secondBatch = onChange.mock.calls[1][0];
    expect(secondBatch.map((s) => s.streamId)).toEqual(['conv_b']);
  });

  it('handles rename events for both old and new paths', async () => {
    const { watcher, fire, onChange } = build({ debounceMs: 50 });
    watcher.start();

    fire(
      'rename',
      makeTFile('Nexus/data/conversations/conv_new/shard-000.jsonl'),
      'Nexus/data/conversations/conv_old/shard-000.jsonl'
    );

    await jest.advanceTimersByTimeAsync(50);
    const modified: ModifiedStream[] = onChange.mock.calls[0][0];
    const streamIds = modified.map((m) => m.streamId).sort();
    expect(streamIds).toEqual(['conv_new', 'conv_old']);
  });

  it('does not fire after stop()', async () => {
    const { watcher, fire, onChange } = build({ debounceMs: 50 });
    watcher.start();

    fire('modify', makeTFile('Nexus/data/conversations/conv_abc/shard-000.jsonl'));
    watcher.stop();
    await jest.advanceTimersByTimeAsync(100);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('supports updating dataPath via setDataPath', async () => {
    const { watcher, fire, onChange } = build({ debounceMs: 50 });
    watcher.start();

    watcher.setDataPath('OtherFolder/data');

    // Old path no longer matches.
    fire('modify', makeTFile('Nexus/data/conversations/conv_abc/shard-000.jsonl'));
    await jest.advanceTimersByTimeAsync(50);
    expect(onChange).not.toHaveBeenCalled();

    // New path matches.
    fire('modify', makeTFile('OtherFolder/data/conversations/conv_xyz/shard-000.jsonl'));
    await jest.advanceTimersByTimeAsync(50);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0][0].streamId).toBe('conv_xyz');
  });

  describe('create and delete events', () => {
    it('fires onChange for a create event on a new JSONL shard', async () => {
      const { watcher, fire, onChange } = build({ debounceMs: 50 });
      watcher.start();

      fire('create', makeTFile('Nexus/data/conversations/conv_sync/shard-000.jsonl'));
      await jest.advanceTimersByTimeAsync(50);

      expect(onChange).toHaveBeenCalledTimes(1);
      const modified: ModifiedStream[] = onChange.mock.calls[0][0];
      expect(modified).toHaveLength(1);
      expect(modified[0]).toMatchObject({
        category: 'conversations',
        streamId: 'conv_sync',
        businessId: 'sync'
      });
    });

    it('fires onChange for a delete event on a JSONL shard', async () => {
      const { watcher, fire, onChange } = build({ debounceMs: 50 });
      watcher.start();

      fire('delete', makeTFile('Nexus/data/workspaces/ws_work-1/shard-000.jsonl'));
      await jest.advanceTimersByTimeAsync(50);

      expect(onChange).toHaveBeenCalledTimes(1);
      const modified: ModifiedStream[] = onChange.mock.calls[0][0];
      expect(modified).toHaveLength(1);
      expect(modified[0]).toMatchObject({
        category: 'workspaces',
        streamId: 'ws_work-1',
        businessId: 'work-1'
      });
    });

    it('classifies stream types correctly for create events across categories', async () => {
      const { watcher, fire, onChange } = build({ debounceMs: 50 });
      watcher.start();

      fire('create', makeTFile('Nexus/data/conversations/conv_chat-1/shard-000.jsonl'));
      fire('create', makeTFile('Nexus/data/workspaces/ws_ws-2/shard-000.jsonl'));
      fire('create', makeTFile('Nexus/data/tasks/tasks_proj-3/shard-000.jsonl'));

      await jest.advanceTimersByTimeAsync(50);

      expect(onChange).toHaveBeenCalledTimes(1);
      const modified: ModifiedStream[] = onChange.mock.calls[0][0];
      expect(modified).toHaveLength(3);

      const byCategory = Object.fromEntries(modified.map((m) => [m.category, m]));
      expect(byCategory['conversations']).toMatchObject({
        streamId: 'conv_chat-1',
        businessId: 'chat-1'
      });
      expect(byCategory['workspaces']).toMatchObject({
        streamId: 'ws_ws-2',
        businessId: 'ws-2'
      });
      expect(byCategory['tasks']).toMatchObject({
        streamId: 'tasks_proj-3',
        businessId: 'proj-3'
      });
    });

    it('ignores create events for non-jsonl files inside the data path', async () => {
      const { watcher, fire, onChange } = build({ debounceMs: 50 });
      watcher.start();

      fire('create', makeTFile('Nexus/data/_meta/storage-manifest.json'));
      fire('create', makeTFile('Nexus/data/conversations/conv_abc/metadata.json'));

      await jest.advanceTimersByTimeAsync(50);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('respects self-write suppression for create events', async () => {
      const { watcher, fire, onChange } = build({ debounceMs: 50 });
      watcher.start();

      watcher.suppressLogicalPath('conversations/conv_local.jsonl');
      fire('create', makeTFile('Nexus/data/conversations/conv_local/shard-000.jsonl'));

      await jest.advanceTimersByTimeAsync(50);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('error resilience', () => {
    it('continues processing events after onChange throws synchronously', async () => {
      const onChange = jest.fn<Promise<void>, [ModifiedStream[]]>();
      const { app, fire } = createMockApp();
      const watcher = new JsonlVaultWatcher({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        app: app as any,
        dataPath: 'Nexus/data',
        onChange,
        debounceMs: 50
      });

      // First call throws.
      onChange.mockImplementationOnce(() => { throw new Error('boom'); });
      // Second call succeeds.
      onChange.mockImplementationOnce(() => Promise.resolve());

      watcher.start();

      // First event — onChange throws.
      fire('modify', makeTFile('Nexus/data/conversations/conv_a/shard-000.jsonl'));
      await jest.advanceTimersByTimeAsync(50);
      expect(onChange).toHaveBeenCalledTimes(1);

      // Second event — should still work (dispatching flag was reset).
      fire('modify', makeTFile('Nexus/data/conversations/conv_b/shard-000.jsonl'));
      await jest.advanceTimersByTimeAsync(50);
      expect(onChange).toHaveBeenCalledTimes(2);
    });

    it('continues processing events after onChange rejects', async () => {
      const onChange = jest.fn<Promise<void>, [ModifiedStream[]]>();
      const { app, fire } = createMockApp();
      const watcher = new JsonlVaultWatcher({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        app: app as any,
        dataPath: 'Nexus/data',
        onChange,
        debounceMs: 50
      });

      // First call rejects.
      onChange.mockImplementationOnce(() => Promise.reject(new Error('async boom')));
      // Second call succeeds.
      onChange.mockImplementationOnce(() => Promise.resolve());

      watcher.start();

      // First event — onChange rejects.
      fire('modify', makeTFile('Nexus/data/conversations/conv_a/shard-000.jsonl'));
      await jest.advanceTimersByTimeAsync(50);
      // Allow the rejected promise to settle.
      await Promise.resolve();
      await Promise.resolve();
      expect(onChange).toHaveBeenCalledTimes(1);

      // Second event — should still work (dispatching flag was reset by finally).
      fire('modify', makeTFile('Nexus/data/conversations/conv_b/shard-000.jsonl'));
      await jest.advanceTimersByTimeAsync(50);
      expect(onChange).toHaveBeenCalledTimes(2);
    });

    it('processes queued changes after onChange throws during dispatch', async () => {
      const onChange = jest.fn<Promise<void>, [ModifiedStream[]]>();
      const { app, fire } = createMockApp();
      const watcher = new JsonlVaultWatcher({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        app: app as any,
        dataPath: 'Nexus/data',
        onChange,
        debounceMs: 50
      });

      // First call: long-running then throws. Second: succeeds.
      let rejectFirst: ((err: Error) => void) | undefined;
      onChange.mockImplementationOnce(
        () => new Promise<void>((_, reject) => { rejectFirst = reject; })
      );
      onChange.mockImplementationOnce(() => Promise.resolve());

      watcher.start();

      // First event triggers dispatch.
      fire('modify', makeTFile('Nexus/data/conversations/conv_a/shard-000.jsonl'));
      await jest.advanceTimersByTimeAsync(50);
      expect(onChange).toHaveBeenCalledTimes(1);

      // While first dispatch is in-flight, a new change lands (queued).
      fire('modify', makeTFile('Nexus/data/conversations/conv_b/shard-000.jsonl'));
      await jest.advanceTimersByTimeAsync(50);

      // First dispatch fails — queued dispatch should still fire.
      rejectFirst?.(new Error('dispatch failure'));
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(50);

      expect(onChange).toHaveBeenCalledTimes(2);
      const secondBatch = onChange.mock.calls[1][0];
      expect(secondBatch.map((s: ModifiedStream) => s.streamId)).toEqual(['conv_b']);
    });
  });
});
