import type { App } from 'obsidian';

import { VaultEventStore } from '../../src/database/storage/vaultRoot/VaultEventStore';
import {
  VaultRootMigrationService
} from '../../src/database/migration/VaultRootMigrationService';

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

function jsonl(events: Record<string, unknown>[]): string {
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
}

function createLegacyConversationEvents(conversationId: string) {
  return [
    {
      id: `meta-${conversationId}`,
      type: 'metadata',
      deviceId: 'legacy-device',
      timestamp: 1,
      data: {
        id: conversationId,
        title: 'Legacy conversation',
        created: 1,
        vault: 'Vault'
      }
    },
    {
      id: `msg-${conversationId}`,
      type: 'message',
      deviceId: 'legacy-device',
      timestamp: 2,
      conversationId,
      data: {
        id: `message-${conversationId}`,
        role: 'user',
        content: 'Hello',
        sequenceNumber: 0
      }
    }
  ];
}

describe('VaultRootMigrationService', () => {
  it('copies legacy files from multiple categories into vault-root shards', async () => {
    const conversationId = 'conv_alpha';
    const workspaceId = 'ws_alpha';
    const taskWorkspaceId = 'ws_alpha';

    const conversationEvents = createLegacyConversationEvents(conversationId);
    const workspaceEvents = [
      {
        id: 'workspace-meta',
        type: 'workspace_created',
        deviceId: 'legacy-device',
        timestamp: 3,
        data: {
          id: workspaceId,
          name: 'Legacy workspace',
          created: 3,
          rootFolder: 'Vault/Projects'
        }
      }
    ];
    const taskEvents = [
      {
        id: 'project-meta',
        type: 'project_created',
        deviceId: 'legacy-device',
        timestamp: 4,
        data: {
          id: 'project-alpha',
          workspaceId: taskWorkspaceId,
          name: 'Legacy project',
          created: 4
        }
      }
    ];

    const { app, adapter } = createMockApp({
      '.nexus/conversations/conv_conv_alpha.jsonl': jsonl(conversationEvents),
      '.obsidian/plugins/claudesidian-mcp/data/workspaces/ws_alpha.jsonl': jsonl(workspaceEvents),
      '.nexus/tasks/tasks_ws_alpha.jsonl': jsonl(taskEvents)
    });

    const vaultEventStore = new VaultEventStore({
      app,
      resolution: {
        resolvedPath: 'Assistant data',
        dataPath: 'Assistant data/data',
        maxShardBytes: 4096
      }
    });

    const service = new VaultRootMigrationService({
      app,
      vaultEventStore,
      legacyRoots: ['.nexus', '.obsidian/plugins/claudesidian-mcp/data']
    });

    const result = await service.backfillLegacyRoots();

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.eventsCopied).toBe(4);
    expect(result.filesCopied).toBe(3);
    expect(result.conflicts).toHaveLength(0);
    expect(adapter.write).toHaveBeenCalledWith(
      'Assistant data/data/conversations/conv_alpha/shard-000001.jsonl',
      expect.stringContaining('"type":"metadata"')
    );

    expect(await vaultEventStore.readEvents('conversations/conv_alpha.jsonl')).toEqual(conversationEvents);
    expect(await vaultEventStore.readEvents('workspaces/ws_alpha.jsonl')).toEqual(workspaceEvents);
    expect(await vaultEventStore.readEvents('tasks/tasks_ws_alpha.jsonl')).toEqual(taskEvents);
  });

  it('is idempotent on rerun and does not duplicate already-copied events', async () => {
    const conversationEvents = createLegacyConversationEvents('conv_beta');

    const { app, adapter } = createMockApp({
      '.nexus/conversations/conv_conv_beta.jsonl': jsonl(conversationEvents)
    });

    const vaultEventStore = new VaultEventStore({
      app,
      resolution: {
        resolvedPath: 'Assistant data',
        dataPath: 'Assistant data/data',
        maxShardBytes: 4096
      }
    });

    const service = new VaultRootMigrationService({
      app,
      vaultEventStore,
      legacyRoots: ['.nexus']
    });

    const firstResult = await service.backfillLegacyRoots();
    const dataWriteCountAfterFirstRun = adapter.write.mock.calls.filter(([path]) => !path.includes('/_meta/')).length;
    const appendCountAfterFirstRun = adapter.append.mock.calls.length;

    const secondResult = await service.backfillLegacyRoots();

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    expect(secondResult.eventsCopied).toBe(0);
    expect(adapter.write.mock.calls.filter(([path]) => !path.includes('/_meta/')).length).toBe(
      dataWriteCountAfterFirstRun
    );
    expect(adapter.append.mock.calls.length).toBe(appendCountAfterFirstRun);
    expect(await vaultEventStore.readEvents('conversations/conv_beta.jsonl')).toEqual(conversationEvents);
  });

  it('fails verification when vault-root content conflicts with legacy content', async () => {
    const legacyEvents = createLegacyConversationEvents('conv_conflict');
    const conflictingVaultEvents = [
      {
        ...legacyEvents[0],
        data: {
          ...(legacyEvents[0] as Record<string, unknown>).data as Record<string, unknown>,
          title: 'Conflicting title'
        }
      },
      legacyEvents[1]
    ];

    const { app } = createMockApp({
      '.nexus/conversations/conv_conflict.jsonl': jsonl(legacyEvents),
      'Assistant data/data/conversations/conv_conflict/shard-000001.jsonl': jsonl(conflictingVaultEvents)
    });

    const vaultEventStore = new VaultEventStore({
      app,
      resolution: {
        resolvedPath: 'Assistant data',
        dataPath: 'Assistant data/data',
        maxShardBytes: 4096
      }
    });

    const service = new VaultRootMigrationService({
      app,
      vaultEventStore,
      legacyRoots: ['.nexus']
    });

    const result = await service.backfillLegacyRoots();

    expect(result.success).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].reason).toBe('vault-content-conflict');
    expect(result.fileResults[0].verified).toBe(false);
  });

  it('normalizes conv_conv conversation filenames to a single stream path', async () => {
    const events = createLegacyConversationEvents('conv_gamma');

    const { app } = createMockApp({
      '.nexus/conversations/conv_conv_gamma.jsonl': jsonl(events)
    });

    const vaultEventStore = new VaultEventStore({
      app,
      resolution: {
        resolvedPath: 'Assistant data',
        dataPath: 'Assistant data/data',
        maxShardBytes: 4096
      }
    });

    const service = new VaultRootMigrationService({
      app,
      vaultEventStore,
      legacyRoots: ['.nexus']
    });

    const result = await service.backfillLegacyRoots();

    expect(result.success).toBe(true);
    expect(result.fileResults[0].streamPath).toBe('conversations/conv_gamma.jsonl');
    expect(await vaultEventStore.listFiles('conversations')).toEqual(['conversations/conv_gamma.jsonl']);
  });
});
