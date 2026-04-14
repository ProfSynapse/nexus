import type { App } from 'obsidian';

import { VaultEventStore } from '../../src/database/storage/vaultRoot/VaultEventStore';
import { JSONLWriter } from '../../src/database/storage/JSONLWriter';

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
    loadLocalStorage: jest.fn().mockReturnValue('device-a'),
    saveLocalStorage: jest.fn(),
    vault: {
      adapter
    }
  } as unknown as App;

  return { app, adapter };
}

describe('JSONLWriter', () => {
  it('merges primary and fallback read roots without duplicating event ids', async () => {
    const { app } = createMockApp({
      '.obsidian/plugins/claudesidian-mcp/data/conversations/conv_alpha.jsonl': '{"id":"evt-1","deviceId":"a","timestamp":1}\n',
      '.nexus/conversations/conv_alpha.jsonl': '{"id":"evt-1","deviceId":"a","timestamp":1}\n{"id":"evt-2","deviceId":"b","timestamp":2}\n'
    });

    const writer = new JSONLWriter({
      app,
      basePath: '.obsidian/plugins/claudesidian-mcp/data',
      readBasePaths: ['.obsidian/plugins/claudesidian-mcp/data', '.nexus']
    });

    const events = await writer.readEvents<{ id: string; deviceId: string; timestamp: number }>('conversations/conv_alpha.jsonl');

    expect(events).toEqual([
      { id: 'evt-1', deviceId: 'a', timestamp: 1 },
      { id: 'evt-2', deviceId: 'b', timestamp: 2 }
    ]);
  });

  it('routes vault-root logical files through sharded storage without exposing shards to callers', async () => {
    const { app, adapter } = createMockApp({
      '.nexus/conversations/conv_alpha.jsonl': '{"id":"legacy-evt","deviceId":"legacy","timestamp":1}\n'
    });

    const vaultEventStore = new VaultEventStore({
      app,
      resolution: {
        resolvedPath: 'Assistant data',
        dataPath: 'Assistant data/data',
        maxShardBytes: 1024
      }
    });

    const writer = new JSONLWriter({
      app,
      basePath: '.nexus',
      readBasePaths: ['.nexus'],
      vaultEventStore
    });

    const appended = await writer.appendEvent(
      'conversations/conv_conv_alpha.jsonl',
      {
        type: 'message',
        conversationId: 'conv_alpha',
        data: { body: 'hello' }
      } as never
    );

    expect(adapter.write).toHaveBeenCalledWith(
      'Assistant data/data/conversations/conv_alpha/shard-000001.jsonl',
      expect.stringContaining('"type":"message"')
    );
    expect(appended.id).toBeDefined();

    const batchEvents = await writer.appendEvents(
      'tasks/tasks_ws-1.jsonl',
      [
        {
          type: 'project_created',
          data: { id: 'p-1', workspaceId: 'ws-1', name: 'Project 1' }
        },
        {
          type: 'project_created',
          data: { id: 'p-2', workspaceId: 'ws-1', name: 'Project 2' }
        }
      ] as never
    );

    expect(batchEvents).toHaveLength(2);
    expect(adapter.write).toHaveBeenCalledWith(
      'Assistant data/data/tasks/tasks_ws-1/shard-000001.jsonl',
      expect.stringContaining('"name":"Project 1"')
    );

    expect(await writer.listFiles('conversations')).toEqual(['conversations/conv_alpha.jsonl']);

    const events = await writer.readEvents<{ id: string; deviceId: string; timestamp: number }>(
      'conversations/conv_conv_alpha.jsonl'
    );

    expect(events.map(event => event.id)).toContain(appended.id);
    expect(events.map(event => event.id)).toContain('legacy-evt');

    expect(await writer.getFileModTime('conversations/conv_conv_alpha.jsonl')).not.toBeNull();
    expect(await writer.getFileSize('conversations/conv_conv_alpha.jsonl')).toBeGreaterThan(0);
    expect(await writer.getEventsNotFromDevice('conversations/conv_conv_alpha.jsonl', writer.getDeviceId())).toEqual([
      expect.objectContaining({ id: 'legacy-evt' })
    ]);
  });
});
