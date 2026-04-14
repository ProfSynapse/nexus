import { VaultEventStore } from '../../src/database/storage/vaultRoot/VaultEventStore';
import {
  VaultRootRelocationService
} from '../../src/database/migration/VaultRootRelocationService';
import { createMockApp } from '../helpers/mockVaultAdapter';

describe('VaultRootRelocationService', () => {
  it('copies event streams into a new vault root without deleting the source root', async () => {
    const { app, adapter } = createMockApp({ configDir: '.obsidian' });
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
    const { app, adapter } = createMockApp({ configDir: '.obsidian' });
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
