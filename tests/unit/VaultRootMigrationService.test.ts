import { VaultEventStore } from '../../src/database/storage/vaultRoot/VaultEventStore';
import {
  VaultRootMigrationService
} from '../../src/database/migration/VaultRootMigrationService';
import { createMockApp } from '../helpers/mockVaultAdapter';

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

    const { app, adapter } = createMockApp({ initialFiles: {
      '.nexus/conversations/conv_conv_alpha.jsonl': jsonl(conversationEvents),
      '.obsidian/plugins/claudesidian-mcp/data/workspaces/ws_alpha.jsonl': jsonl(workspaceEvents),
      '.nexus/tasks/tasks_ws_alpha.jsonl': jsonl(taskEvents)
    }});

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

    const { app, adapter } = createMockApp({ initialFiles: {
      '.nexus/conversations/conv_conv_beta.jsonl': jsonl(conversationEvents)
    }});

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

    const { app } = createMockApp({ initialFiles: {
      '.nexus/conversations/conv_conflict.jsonl': jsonl(legacyEvents),
      'Assistant data/data/conversations/conv_conflict/shard-000001.jsonl': jsonl(conflictingVaultEvents)
    }});

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

    const { app } = createMockApp({ initialFiles: {
      '.nexus/conversations/conv_conv_gamma.jsonl': jsonl(events)
    }});

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
