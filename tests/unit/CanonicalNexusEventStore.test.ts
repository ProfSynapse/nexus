import type { App } from 'obsidian';

import { resolveCanonicalVaultRoot } from '../../src/database/storage/CanonicalVaultRootResolver';
import { CanonicalNexusEventStore } from '../../src/database/storage/canonical/CanonicalNexusEventStore';

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

describe('CanonicalNexusEventStore', () => {
  it('constructs from resolved canonical root settings', () => {
    const resolution = resolveCanonicalVaultRoot({
      storage: {
        rootPath: 'storage/nexus',
        maxShardBytes: 2_097_152
      }
    }, { configDir: '.obsidian' });

    const store = new CanonicalNexusEventStore({
      app: createMockApp(),
      resolution
    });

    expect(store.getRootPath()).toBe('storage/nexus');
    expect(store.getMaxShardBytes()).toBe(2_097_152);
    expect(store.getMetaRootPath()).toBe('storage/nexus/_meta');
    expect(store.getStorageManifestPath()).toBe('storage/nexus/_meta/storage-manifest.json');
    expect(store.getMigrationManifestPath()).toBe('storage/nexus/_meta/migration-manifest.json');
  });

  it('maps conversation, workspace, and task IDs into canonical stream directories', () => {
    const store = new CanonicalNexusEventStore({
      app: createMockApp(),
      resolution: {
        resolvedRootPath: 'Nexus',
        maxShardBytes: 4 * 1024 * 1024
      }
    });

    const conversationStream = store.getConversationStream<{ id: string }>('conv-123');
    const workspaceStream = store.getWorkspaceStream<{ id: string }>('ws-456');
    const taskStream = store.getTaskStream<{ id: string }>('ws-456');

    expect(store.getConversationsRootPath()).toBe('Nexus/conversations');
    expect(store.getWorkspacesRootPath()).toBe('Nexus/workspaces');
    expect(store.getTasksRootPath()).toBe('Nexus/tasks');

    expect(conversationStream.relativeStreamPath).toBe('conversations/conv-123');
    expect(conversationStream.absoluteStreamPath).toBe('Nexus/conversations/conv-123');
    expect(workspaceStream.relativeStreamPath).toBe('workspaces/ws-456');
    expect(workspaceStream.absoluteStreamPath).toBe('Nexus/workspaces/ws-456');
    expect(taskStream.relativeStreamPath).toBe('tasks/ws-456');
    expect(taskStream.absoluteStreamPath).toBe('Nexus/tasks/ws-456');
  });

  it('reuses shard-store configuration for each canonical stream helper', () => {
    const store = new CanonicalNexusEventStore({
      app: createMockApp(),
      resolution: {
        resolvedRootPath: 'Archive/Nexus Data',
        maxShardBytes: 512_000
      }
    });

    const conversationStream = store.getConversationStream<{ id: string }>('conv-123');
    const workspaceStream = store.getWorkspaceStream<{ id: string }>('ws-456');
    const taskStream = store.getTaskStream<{ id: string }>('ws-456');

    expect(conversationStream.shardStore.getRootPath()).toBe('Archive/Nexus Data');
    expect(workspaceStream.shardStore.getRootPath()).toBe('Archive/Nexus Data');
    expect(taskStream.shardStore.getRootPath()).toBe('Archive/Nexus Data');

    expect(conversationStream.shardStore.getMaxShardBytes()).toBe(512_000);
    expect(workspaceStream.shardStore.getMaxShardBytes()).toBe(512_000);
    expect(taskStream.shardStore.getMaxShardBytes()).toBe(512_000);

    expect(
      conversationStream.shardStore.getShardPath(conversationStream.relativeStreamPath, 1)
    ).toBe('Archive/Nexus Data/conversations/conv-123/shard-000001.jsonl');
    expect(
      workspaceStream.shardStore.getShardPath(workspaceStream.relativeStreamPath, 1)
    ).toBe('Archive/Nexus Data/workspaces/ws-456/shard-000001.jsonl');
    expect(taskStream.shardStore.getShardPath(taskStream.relativeStreamPath, 1)).toBe(
      'Archive/Nexus Data/tasks/ws-456/shard-000001.jsonl'
    );
  });

  it('normalizes wrapped slashes in logical IDs and rejects empty IDs', () => {
    const store = new CanonicalNexusEventStore({
      app: createMockApp(),
      resolution: {
        resolvedRootPath: 'Nexus',
        maxShardBytes: 4 * 1024 * 1024
      }
    });

    const conversationStream = store.getConversationStream<{ id: string }>('/conv-123/');

    expect(conversationStream.logicalId).toBe('conv-123');
    expect(conversationStream.relativeStreamPath).toBe('conversations/conv-123');

    expect(() => store.getConversationStream<{ id: string }>('')).toThrow(
      'Canonical stream logical ID cannot be empty.'
    );
  });
});
