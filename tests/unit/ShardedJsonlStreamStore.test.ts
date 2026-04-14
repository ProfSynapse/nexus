import type { App } from 'obsidian';

import { ShardedJsonlStreamStore } from '../../src/database/storage/vaultRoot/ShardedJsonlStreamStore';

type AdapterFileEntry = {
  content: string;
  mtime: number;
  size: number;
};

type MockAdapter = {
  exists: jest.Mock<Promise<boolean>, [string]>;
  read: jest.Mock<Promise<string>, [string]>;
  write: jest.Mock<Promise<void>, [string, string]>;
  append: jest.Mock<Promise<void>, [string, string]>;
  stat: jest.Mock<Promise<{ mtime: number; size: number } | null>, [string]>;
  list: jest.Mock<Promise<{ files: string[]; folders: string[] }>, [string]>;
  mkdir: jest.Mock<Promise<void>, [string]>;
};

function createMockApp(initialFiles: Record<string, string> = {}): {
  app: App;
  adapter: MockAdapter;
} {
  const files = new Map<string, AdapterFileEntry>();
  const directories = new Set<string>();
  let tick = 1;

  const addDirectoryTree = (path: string): void => {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current.length > 0 ? `${current}/${part}` : part;
      directories.add(current);
    }
  };

  const setFile = (path: string, content: string): void => {
    const normalizedPath = path.replace(/\\/g, '/');
    const parent = normalizedPath.includes('/')
      ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/'))
      : '';
    if (parent) {
      addDirectoryTree(parent);
    }
    files.set(normalizedPath, {
      content,
      mtime: tick++,
      size: new TextEncoder().encode(content).byteLength
    });
  };

  for (const [path, content] of Object.entries(initialFiles)) {
    setFile(path, content);
  }

  const adapter: MockAdapter = {
    exists: jest.fn(async (path: string) => {
      const normalizedPath = path.replace(/\\/g, '/');
      return files.has(normalizedPath) || directories.has(normalizedPath);
    }),
    read: jest.fn(async (path: string) => {
      const normalizedPath = path.replace(/\\/g, '/');
      const entry = files.get(normalizedPath);
      if (!entry) {
        throw new Error(`Missing file: ${normalizedPath}`);
      }
      return entry.content;
    }),
    write: jest.fn(async (path: string, content: string) => {
      setFile(path, content);
    }),
    append: jest.fn(async (path: string, content: string) => {
      const normalizedPath = path.replace(/\\/g, '/');
      const existing = files.get(normalizedPath);
      if (!existing) {
        setFile(normalizedPath, content);
        return;
      }
      setFile(normalizedPath, `${existing.content}${content}`);
    }),
    stat: jest.fn(async (path: string) => {
      const normalizedPath = path.replace(/\\/g, '/');
      const entry = files.get(normalizedPath);
      if (!entry) {
        return null;
      }
      return { mtime: entry.mtime, size: entry.size };
    }),
    list: jest.fn(async (path: string) => {
      const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/g, '');
      const filePaths = Array.from(files.keys()).filter(filePath => {
        const parent = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
        return parent === normalizedPath;
      });

      const folderPaths = Array.from(directories.values()).filter(dirPath => {
        const parent = dirPath.includes('/') ? dirPath.slice(0, dirPath.lastIndexOf('/')) : '';
        return parent === normalizedPath;
      });

      return { files: filePaths, folders: folderPaths };
    }),
    mkdir: jest.fn(async (path: string) => {
      addDirectoryTree(path.replace(/\\/g, '/'));
    })
  };

  const app = {
    vault: {
      adapter
    }
  } as unknown as App;

  return { app, adapter };
}

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
    const { app, adapter } = createMockApp({
      'Assistant data/conversations/conv-1/shard-000001.jsonl': `${JSON.stringify(makeEvent('evt-1'))}\n`
    });
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
    const { app, adapter } = createMockApp({
      'Assistant data/conversations/conv-1/shard-000001.jsonl': initialContent
    });
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
    const { app } = createMockApp({
      'Assistant data/conversations/conv-1/shard-000002.jsonl': [
        `${JSON.stringify(makeEvent('evt-3'))}`,
        `${JSON.stringify(makeEvent('evt-4'))}`
      ].join('\n') + '\n',
      'Assistant data/conversations/conv-1/shard-000001.jsonl': [
        `${JSON.stringify(makeEvent('evt-1'))}`,
        `${JSON.stringify(makeEvent('evt-2'))}`
      ].join('\n') + '\n'
    });
    const store = new ShardedJsonlStreamStore({
      app,
      rootPath: 'Assistant data',
      maxShardBytes: 1024
    });

    const events = await store.readEvents('conversations/conv-1');

    expect(events.map(event => event.id)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4']);
  });

  it('returns shard descriptors in numeric order', async () => {
    const { app } = createMockApp({
      'Assistant data/conversations/conv-1/shard-000003.jsonl': `${JSON.stringify(makeEvent('evt-3'))}\n`,
      'Assistant data/conversations/conv-1/shard-000001.jsonl': `${JSON.stringify(makeEvent('evt-1'))}\n`,
      'Assistant data/conversations/conv-1/shard-000002.jsonl': `${JSON.stringify(makeEvent('evt-2'))}\n`
    });
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
});
