import type { App } from 'obsidian';

import { VaultEventStore } from '../../src/database/storage/vaultRoot/VaultEventStore';
import {
  VaultRootRelocationService
} from '../../src/database/migration/VaultRootRelocationService';

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
      configDir: '.obsidian',
      adapter
    }
  } as unknown as App;

  return { app, adapter };
}

describe('VaultRootRelocationService', () => {
  it('copies event streams into a new vault root without deleting the source root', async () => {
    const { app, adapter } = createMockApp();
    const sourceStore = new VaultEventStore({
      app,
      resolution: {
        resolvedPath: 'Assistant data',
        dataPath: 'Assistant data/data',
        maxShardBytes: 1024
      }
    });
    const destinationSeedStore = new VaultEventStore({
      app,
      resolution: {
        resolvedPath: 'Archive/Assistant data',
        dataPath: 'Archive/Assistant data/data',
        maxShardBytes: 1024
      }
    });

    await sourceStore.appendEvents('conversations/conv_alpha.jsonl', [
      {
        id: 'meta-alpha',
        type: 'metadata',
        deviceId: 'device-a',
        timestamp: 1,
        data: {
          id: 'conv_alpha',
          title: 'Alpha'
        }
      },
      {
        id: 'msg-alpha',
        type: 'message',
        deviceId: 'device-a',
        timestamp: 2,
        data: {
          id: 'message-alpha',
          content: 'Hello'
        }
      }
    ]);
    await sourceStore.appendEvents('workspaces/ws_alpha.jsonl', [
      {
        id: 'workspace-alpha',
        type: 'workspace_created',
        deviceId: 'device-a',
        timestamp: 3,
        data: {
          id: 'ws_alpha',
          name: 'Alpha workspace'
        }
      }
    ]);
    await destinationSeedStore.appendEvents('workspaces/ws_extra.jsonl', [
      {
        id: 'workspace-extra',
        type: 'workspace_created',
        deviceId: 'device-b',
        timestamp: 4,
        data: {
          id: 'ws_extra',
          name: 'Extra workspace'
        }
      }
    ]);

    const service = new VaultRootRelocationService({
      app,
      sourceStore,
      targetRootPath: 'Archive/Assistant data',
      maxShardBytes: 1024
    });

    const result = await service.relocateVaultRoot();

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.relation).toBe('strict-superset');
    expect(result.destinationRootPath).toBe('Archive/Assistant data/data');
    expect(result.destinationStore).toBeDefined();
    expect(result.fileResults).toHaveLength(2);
    expect(result.copiedEventCount).toBe(3);
    expect(result.skippedEventCount).toBe(0);

    expect(await sourceStore.readEvents('conversations/conv_alpha.jsonl')).toEqual([
      expect.objectContaining({ id: 'meta-alpha' }),
      expect.objectContaining({ id: 'msg-alpha' })
    ]);
    expect(await sourceStore.readEvents('workspaces/ws_alpha.jsonl')).toEqual([
      expect.objectContaining({ id: 'workspace-alpha' })
    ]);
    expect(await result.destinationStore!.readEvents('conversations/conv_alpha.jsonl')).toEqual([
      expect.objectContaining({ id: 'meta-alpha' }),
      expect.objectContaining({ id: 'msg-alpha' })
    ]);
    expect(await result.destinationStore!.readEvents('workspaces/ws_alpha.jsonl')).toEqual([
      expect.objectContaining({ id: 'workspace-alpha' })
    ]);
    expect(await result.destinationStore!.listFiles('workspaces')).toEqual(
      expect.arrayContaining(['workspaces/ws_alpha.jsonl', 'workspaces/ws_extra.jsonl'])
    );
    expect(adapter.write).toHaveBeenCalledWith(
      'Archive/Assistant data/data/_meta/storage-manifest.json',
      expect.any(String)
    );
  });

  it('fails safely when destination content conflicts with source content', async () => {
    const { app, adapter } = createMockApp();
    const sourceStore = new VaultEventStore({
      app,
      resolution: {
        resolvedPath: 'Assistant data',
        dataPath: 'Assistant data/data',
        maxShardBytes: 1024
      }
    });
    const destinationSeedStore = new VaultEventStore({
      app,
      resolution: {
        resolvedPath: 'Archive/Assistant data',
        dataPath: 'Archive/Assistant data/data',
        maxShardBytes: 1024
      }
    });

    await sourceStore.appendEvents('conversations/conv_conflict.jsonl', [
      {
        id: 'meta-conflict',
        type: 'metadata',
        deviceId: 'device-a',
        timestamp: 1,
        data: {
          id: 'conv_conflict',
          title: 'Source title'
        }
      }
    ]);
    await destinationSeedStore.appendEvents('conversations/conv_conflict.jsonl', [
      {
        id: 'meta-conflict',
        type: 'metadata',
        deviceId: 'device-b',
        timestamp: 1,
        data: {
          id: 'conv_conflict',
          title: 'Conflicting title'
        }
      }
    ]);

    const writesBefore = adapter.write.mock.calls.length;
    const appendsBefore = adapter.append.mock.calls.length;

    const service = new VaultRootRelocationService({
      app,
      sourceStore,
      targetRootPath: 'Archive/Assistant data',
      maxShardBytes: 1024
    });

    const result = await service.relocateVaultRoot();

    expect(result.success).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.relation).toBe('conflict');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].reason).toBe('destination-content-conflict');
    expect(result.destinationStore).toBeUndefined();
    expect(adapter.write.mock.calls.length).toBe(writesBefore);
    expect(adapter.append.mock.calls.length).toBe(appendsBefore);
  });
});
