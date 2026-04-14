import { ShardedJsonlStreamStore } from '../../src/database/storage/vaultRoot/ShardedJsonlStreamStore';
import { createMockApp } from '../helpers/mockVaultAdapter';

function makeEvent(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'test_event',
    ...extra
  };
}

describe('ShardedJsonlStreamStore', () => {
  it('creates the first shard on initial append', async () => {
    const { app, adapter } = createMockApp();
    const store = new ShardedJsonlStreamStore({
      app,
      rootPath: 'Assistant data',
      maxShardBytes: 1024
    });

    const result = await store.appendEvent('conversations/conv-1', makeEvent('evt-1'));

    expect(result.createdShard).toBe(true);
    expect(result.rotated).toBe(false);
    expect(result.shard.fileName).toBe('shard-000001.jsonl');
    expect(result.shard.fullPath).toBe('Assistant data/conversations/conv-1/shard-000001.jsonl');
    expect(adapter.mkdir).toHaveBeenCalledWith('Assistant data');
    expect(adapter.mkdir).toHaveBeenCalledWith('Assistant data/conversations');
    expect(adapter.mkdir).toHaveBeenCalledWith('Assistant data/conversations/conv-1');
    expect(adapter.write).toHaveBeenCalledWith(
      'Assistant data/conversations/conv-1/shard-000001.jsonl',
      `${JSON.stringify(makeEvent('evt-1'))}\n`
    );
  });

  it('appends to the current shard without rotating under the size limit', async () => {
    const { app, adapter } = createMockApp({ initialFiles: {
      'Assistant data/conversations/conv-1/shard-000001.jsonl': `${JSON.stringify(makeEvent('evt-1'))}\n`
    }});
    const store = new ShardedJsonlStreamStore({
      app,
      rootPath: 'Assistant data',
      maxShardBytes: 1024
    });

    const result = await store.appendEvent('conversations/conv-1', makeEvent('evt-2'));

    expect(result.createdShard).toBe(false);
    expect(result.rotated).toBe(false);
    expect(result.shard.fileName).toBe('shard-000001.jsonl');
    expect(adapter.append).toHaveBeenCalledWith(
      'Assistant data/conversations/conv-1/shard-000001.jsonl',
      `${JSON.stringify(makeEvent('evt-2'))}\n`
    );
    expect(adapter.write).not.toHaveBeenCalledWith(
      'Assistant data/conversations/conv-1/shard-000002.jsonl',
      expect.any(String)
    );
  });

  it('rotates to a new shard when the next append would cross the byte limit', async () => {
    const initialContent = `${JSON.stringify(makeEvent('evt-1', { payload: 'x'.repeat(20) }))}\n`;
    const { app, adapter } = createMockApp({ initialFiles: {
      'Assistant data/conversations/conv-1/shard-000001.jsonl': initialContent
    }});
    const store = new ShardedJsonlStreamStore({
      app,
      rootPath: 'Assistant data',
      maxShardBytes: initialContent.length + 5
    });

    const result = await store.appendEvent('conversations/conv-1', makeEvent('evt-2'));

    expect(result.createdShard).toBe(true);
    expect(result.rotated).toBe(true);
    expect(result.shard.fileName).toBe('shard-000002.jsonl');
    expect(adapter.write).toHaveBeenCalledWith(
      'Assistant data/conversations/conv-1/shard-000002.jsonl',
      `${JSON.stringify(makeEvent('evt-2'))}\n`
    );
  });

  it('reads events across shards in shard order', async () => {
    const { app } = createMockApp({ initialFiles: {
      'Assistant data/conversations/conv-1/shard-000002.jsonl': [
        `${JSON.stringify(makeEvent('evt-3'))}`,
        `${JSON.stringify(makeEvent('evt-4'))}`
      ].join('\n') + '\n',
      'Assistant data/conversations/conv-1/shard-000001.jsonl': [
        `${JSON.stringify(makeEvent('evt-1'))}`,
        `${JSON.stringify(makeEvent('evt-2'))}`
      ].join('\n') + '\n'
    }});
    const store = new ShardedJsonlStreamStore({
      app,
      rootPath: 'Assistant data',
      maxShardBytes: 1024
    });

    const events = await store.readEvents('conversations/conv-1');

    expect(events.map(event => event.id)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4']);
  });

  it('returns shard descriptors in numeric order', async () => {
    const { app } = createMockApp({ initialFiles: {
      'Assistant data/conversations/conv-1/shard-000003.jsonl': `${JSON.stringify(makeEvent('evt-3'))}\n`,
      'Assistant data/conversations/conv-1/shard-000001.jsonl': `${JSON.stringify(makeEvent('evt-1'))}\n`,
      'Assistant data/conversations/conv-1/shard-000002.jsonl': `${JSON.stringify(makeEvent('evt-2'))}\n`
    }});
    const store = new ShardedJsonlStreamStore({
      app,
      rootPath: 'Assistant data'
    });

    const shards = await store.listShards('conversations/conv-1');

    expect(shards.map(shard => shard.fileName)).toEqual([
      'shard-000001.jsonl',
      'shard-000002.jsonl',
      'shard-000003.jsonl'
    ]);
  });

  describe('error paths', () => {
    it('skips malformed JSON lines and returns only valid events', async () => {
      const content = [
        JSON.stringify(makeEvent('evt-1')),
        'NOT VALID JSON {{{',
        JSON.stringify(makeEvent('evt-2')),
        '',
        '   ',
        JSON.stringify(makeEvent('evt-3'))
      ].join('\n') + '\n';

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const { app } = createMockApp({ initialFiles: {
        'root/stream/shard-000001.jsonl': content
      }});
      const store = new ShardedJsonlStreamStore({ app, rootPath: 'root', maxShardBytes: 1024 });

      const events = await store.readEvents('stream');

      expect(events.map(e => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping malformed line')
      );
      warnSpy.mockRestore();
    });

    it('returns an empty array when all lines are malformed', async () => {
      const content = 'bad1\nbad2\n{not json}\n';

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const { app } = createMockApp({ initialFiles: {
        'root/stream/shard-000001.jsonl': content
      }});
      const store = new ShardedJsonlStreamStore({ app, rootPath: 'root', maxShardBytes: 1024 });

      const events = await store.readEvents('stream');

      expect(events).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(3);
      warnSpy.mockRestore();
    });

    it('returns an empty array for an empty shard', async () => {
      const { app } = createMockApp({ initialFiles: {
        'root/stream/shard-000001.jsonl': '   \n\n  \n'
      }});
      const store = new ShardedJsonlStreamStore({ app, rootPath: 'root', maxShardBytes: 1024 });

      const events = await store.readEvents('stream');

      expect(events).toEqual([]);
    });

    it('returns an empty array when the stream directory does not exist', async () => {
      const { app } = createMockApp();
      const store = new ShardedJsonlStreamStore({ app, rootPath: 'root', maxShardBytes: 1024 });

      const events = await store.readEvents('nonexistent');

      expect(events).toEqual([]);
    });
  });

  describe('maxShardBytes=1 boundary', () => {
    it('rotates to a new shard on every append when maxShardBytes is 1', async () => {
      const { app } = createMockApp();
      const store = new ShardedJsonlStreamStore({ app, rootPath: 'root', maxShardBytes: 1 });

      const r1 = await store.appendEvent('stream', makeEvent('evt-1'));
      const r2 = await store.appendEvent('stream', makeEvent('evt-2'));
      const r3 = await store.appendEvent('stream', makeEvent('evt-3'));

      expect(r1.shard.fileName).toBe('shard-000001.jsonl');
      expect(r1.createdShard).toBe(true);
      expect(r1.rotated).toBe(false);

      expect(r2.shard.fileName).toBe('shard-000002.jsonl');
      expect(r2.createdShard).toBe(true);
      expect(r2.rotated).toBe(true);

      expect(r3.shard.fileName).toBe('shard-000003.jsonl');
      expect(r3.createdShard).toBe(true);
      expect(r3.rotated).toBe(true);

      const allEvents = await store.readEvents('stream');
      expect(allEvents.map(e => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    });

    it('clamps maxShardBytes to minimum of 1', () => {
      const { app } = createMockApp();
      const store = new ShardedJsonlStreamStore({ app, rootPath: 'root', maxShardBytes: 0 });

      expect(store.getMaxShardBytes()).toBe(1);
    });

    it('clamps negative maxShardBytes to minimum of 1', () => {
      const { app } = createMockApp();
      const store = new ShardedJsonlStreamStore({ app, rootPath: 'root', maxShardBytes: -100 });

      expect(store.getMaxShardBytes()).toBe(1);
    });
  });

  describe('concurrent append', () => {
    it('does not lose events when multiple appends run concurrently on the same stream', async () => {
      const { app } = createMockApp();
      const store = new ShardedJsonlStreamStore({ app, rootPath: 'root', maxShardBytes: 4096 });

      const promises = Array.from({ length: 10 }, (_, i) =>
        store.appendEvent('stream', makeEvent(`evt-${i}`))
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      const allEvents = await store.readEvents('stream');
      expect(allEvents).toHaveLength(10);

      const ids = allEvents.map(e => e.id).sort();
      const expectedIds = Array.from({ length: 10 }, (_, i) => `evt-${i}`).sort();
      expect(ids).toEqual(expectedIds);
    });

    it('does not lose events when concurrent appends trigger shard rotation', async () => {
      const { app } = createMockApp();
      // Each event is ~40 bytes serialized, so maxShardBytes=50 forces rotation after 1st event
      const store = new ShardedJsonlStreamStore({ app, rootPath: 'root', maxShardBytes: 50 });

      const promises = Array.from({ length: 5 }, (_, i) =>
        store.appendEvent('stream', makeEvent(`evt-${i}`))
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(5);
      const allEvents = await store.readEvents('stream');
      expect(allEvents).toHaveLength(5);

      const ids = allEvents.map(e => e.id).sort();
      const expectedIds = Array.from({ length: 5 }, (_, i) => `evt-${i}`).sort();
      expect(ids).toEqual(expectedIds);

      const shards = await store.listShards('stream');
      expect(shards.length).toBeGreaterThan(1);
    });

    it('does not interleave events across different streams', async () => {
      const { app } = createMockApp();
      const store = new ShardedJsonlStreamStore({ app, rootPath: 'root', maxShardBytes: 4096 });

      const streamAPromises = Array.from({ length: 5 }, (_, i) =>
        store.appendEvent('stream-a', makeEvent(`a-${i}`))
      );
      const streamBPromises = Array.from({ length: 5 }, (_, i) =>
        store.appendEvent('stream-b', makeEvent(`b-${i}`))
      );

      await Promise.all([...streamAPromises, ...streamBPromises]);

      const streamAEvents = await store.readEvents('stream-a');
      const streamBEvents = await store.readEvents('stream-b');

      expect(streamAEvents).toHaveLength(5);
      expect(streamBEvents).toHaveLength(5);
      expect(streamAEvents.every(e => e.id.startsWith('a-'))).toBe(true);
      expect(streamBEvents.every(e => e.id.startsWith('b-'))).toBe(true);
    });
  });
});
