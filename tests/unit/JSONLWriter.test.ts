import { VaultEventStore } from '../../src/database/storage/vaultRoot/VaultEventStore';
import { JSONLWriter } from '../../src/database/storage/JSONLWriter';
import { createMockApp } from '../helpers/mockVaultAdapter';

describe('JSONLWriter', () => {
  it('merges primary and fallback read roots without duplicating event ids', async () => {
    const { app } = createMockApp({ withLocalStorage: true, initialFiles: {
      '.obsidian/plugins/claudesidian-mcp/data/conversations/conv_alpha.jsonl': '{"id":"evt-1","deviceId":"a","timestamp":1}\n',
      '.nexus/conversations/conv_alpha.jsonl': '{"id":"evt-1","deviceId":"a","timestamp":1}\n{"id":"evt-2","deviceId":"b","timestamp":2}\n'
    }});

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
    const { app, adapter } = createMockApp({ withLocalStorage: true, initialFiles: {
      '.nexus/conversations/conv_alpha.jsonl': '{"id":"legacy-evt","deviceId":"legacy","timestamp":1}\n'
    }});

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
