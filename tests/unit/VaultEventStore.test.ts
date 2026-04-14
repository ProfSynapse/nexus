import type { App } from 'obsidian';

import { resolveVaultRoot } from '../../src/database/storage/VaultRootResolver';
import { VaultEventStore } from '../../src/database/storage/vaultRoot/VaultEventStore';

function createMockApp(): App {
  return {
    vault: {
      adapter: {
        exists: jest.fn(),
        list: jest.fn(),
        stat: jest.fn(),
        read: jest.fn(),
        write: jest.fn(),
        append: jest.fn(),
        mkdir: jest.fn()
      }
    }
  } as unknown as App;
}

describe('VaultEventStore', () => {
  it('constructs from resolved data folder settings', () => {
    const resolution = resolveVaultRoot({
      storage: {
        rootPath: 'storage/assistant-data',
        maxShardBytes: 2_097_152
      }
    }, { configDir: '.obsidian' });

    const store = new VaultEventStore({
      app: createMockApp(),
      resolution
    });

    expect(store.getRootPath()).toBe('storage/assistant-data/data');
    expect(store.getMaxShardBytes()).toBe(2_097_152);
    expect(store.getMetaRootPath()).toBe('storage/assistant-data/data/_meta');
    expect(store.getStorageManifestPath()).toBe('storage/assistant-data/data/_meta/storage-manifest.json');
    expect(store.getMigrationManifestPath()).toBe('storage/assistant-data/data/_meta/migration-manifest.json');
  });

  it('writes a lightweight storage manifest in the vault-root meta folder', async () => {
    const app = createMockApp();
    const store = new VaultEventStore({
      app,
      resolution: {
        resolvedPath: 'Assistant data',
        dataPath: 'Assistant data/data',
        maxShardBytes: 2_097_152
      }
    });

    const manifest = await store.writeStorageManifest(1234);

    expect(manifest).toEqual({
      manifestType: 'storage',
      schemaVersion: 2,
      rootPath: 'Assistant data/data',
      maxShardBytes: 2_097_152,
      updatedAt: 1234
    });
    expect(app.vault.adapter.mkdir).toHaveBeenCalledWith('Assistant data/data/_meta');
    expect(app.vault.adapter.write).toHaveBeenCalledWith(
      'Assistant data/data/_meta/storage-manifest.json',
      JSON.stringify(manifest, null, 2)
    );
  });

  it('maps conversation, workspace, and task IDs into stream directories', () => {
    const store = new VaultEventStore({
      app: createMockApp(),
      resolution: {
        resolvedPath: 'Assistant data',
        dataPath: 'Assistant data/data',
        maxShardBytes: 4 * 1024 * 1024
      }
    });

    const conversationStream = store.getConversationStream<{ id: string }>('conv-123');
    const workspaceStream = store.getWorkspaceStream<{ id: string }>('ws-456');
    const taskStream = store.getTaskStream<{ id: string }>('ws-456');

    expect(store.getConversationsRootPath()).toBe('Assistant data/data/conversations');
    expect(store.getWorkspacesRootPath()).toBe('Assistant data/data/workspaces');
    expect(store.getTasksRootPath()).toBe('Assistant data/data/tasks');

    expect(conversationStream.relativeStreamPath).toBe('conversations/conv-123');
    expect(conversationStream.absoluteStreamPath).toBe('Assistant data/data/conversations/conv-123');
    expect(workspaceStream.relativeStreamPath).toBe('workspaces/ws-456');
    expect(workspaceStream.absoluteStreamPath).toBe('Assistant data/data/workspaces/ws-456');
    expect(taskStream.relativeStreamPath).toBe('tasks/ws-456');
    expect(taskStream.absoluteStreamPath).toBe('Assistant data/data/tasks/ws-456');
  });

  it('reuses shard-store configuration for each stream helper', () => {
    const store = new VaultEventStore({
      app: createMockApp(),
      resolution: {
        resolvedPath: 'Archive/Assistant data',
        dataPath: 'Archive/Assistant data/data',
        maxShardBytes: 512_000
      }
    });

    const conversationStream = store.getConversationStream<{ id: string }>('conv-123');
    const workspaceStream = store.getWorkspaceStream<{ id: string }>('ws-456');
    const taskStream = store.getTaskStream<{ id: string }>('ws-456');

    expect(conversationStream.shardStore.getRootPath()).toBe('Archive/Assistant data/data');
    expect(workspaceStream.shardStore.getRootPath()).toBe('Archive/Assistant data/data');
    expect(taskStream.shardStore.getRootPath()).toBe('Archive/Assistant data/data');

    expect(conversationStream.shardStore.getMaxShardBytes()).toBe(512_000);
    expect(workspaceStream.shardStore.getMaxShardBytes()).toBe(512_000);
    expect(taskStream.shardStore.getMaxShardBytes()).toBe(512_000);

    expect(
      conversationStream.shardStore.getShardPath(conversationStream.relativeStreamPath, 1)
    ).toBe('Archive/Assistant data/data/conversations/conv-123/shard-000001.jsonl');
    expect(
      workspaceStream.shardStore.getShardPath(workspaceStream.relativeStreamPath, 1)
    ).toBe('Archive/Assistant data/data/workspaces/ws-456/shard-000001.jsonl');
    expect(taskStream.shardStore.getShardPath(taskStream.relativeStreamPath, 1)).toBe(
      'Archive/Assistant data/data/tasks/ws-456/shard-000001.jsonl'
    );
  });

  it('normalizes wrapped slashes in logical IDs and rejects empty IDs', () => {
    const store = new VaultEventStore({
      app: createMockApp(),
      resolution: {
        resolvedPath: 'Assistant data',
        dataPath: 'Assistant data/data',
        maxShardBytes: 4 * 1024 * 1024
      }
    });

    const conversationStream = store.getConversationStream<{ id: string }>('/conv-123/');

    expect(conversationStream.logicalId).toBe('conv-123');
    expect(conversationStream.relativeStreamPath).toBe('conversations/conv-123');

    expect(() => store.getConversationStream<{ id: string }>('')).toThrow(
      'Event stream ID cannot be empty.'
    );
  });
});
