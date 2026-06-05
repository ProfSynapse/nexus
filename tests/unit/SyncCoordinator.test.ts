import type { StorageEvent } from '../../src/database/interfaces/StorageEvents';
import { SyncCoordinator, type IJSONLWriter, type ISQLiteCacheManager, type SyncState } from '../../src/database/sync/SyncCoordinator';

describe('SyncCoordinator', () => {
  it('saves full rebuild once after replaying all JSONL files', async () => {
    const now = 1_000;
    const eventsByFile: Record<string, StorageEvent[]> = {
      'workspaces/ws_one.jsonl': [{
        id: 'workspace-event-1',
        type: 'workspace_created',
        deviceId: 'desktop-device',
        timestamp: now,
        data: {
          id: 'workspace-1',
          name: 'Workspace one',
          rootFolder: '',
          created: now
        }
      }],
      'workspaces/ws_two.jsonl': [{
        id: 'workspace-event-2',
        type: 'workspace_created',
        deviceId: 'desktop-device',
        timestamp: now + 1,
        data: {
          id: 'workspace-2',
          name: 'Workspace two',
          rootFolder: '',
          created: now + 1
        }
      }],
      'conversations/conv_one.jsonl': [{
        id: 'conversation-event-1',
        type: 'metadata',
        deviceId: 'desktop-device',
        timestamp: now + 2,
        data: {
          id: 'conversation-1',
          title: 'Conversation one',
          created: now + 2,
          vault: 'Test vault'
        }
      }],
      'conversations/conv_two.jsonl': [{
        id: 'conversation-event-2',
        type: 'metadata',
        deviceId: 'desktop-device',
        timestamp: now + 3,
        data: {
          id: 'conversation-2',
          title: 'Conversation two',
          created: now + 3,
          vault: 'Test vault'
        }
      }],
      'tasks/project_one.jsonl': [{
        id: 'task-event-1',
        type: 'project_created',
        deviceId: 'desktop-device',
        timestamp: now + 4,
        data: {
          id: 'project-1',
          workspaceId: 'workspace-1',
          name: 'Project one',
          status: 'active',
          created: now + 4,
          updated: now + 4
        }
      }],
      'tasks/project_two.jsonl': [{
        id: 'task-event-2',
        type: 'project_created',
        deviceId: 'desktop-device',
        timestamp: now + 5,
        data: {
          id: 'project-2',
          workspaceId: 'workspace-2',
          name: 'Project two',
          status: 'active',
          created: now + 5,
          updated: now + 5
        }
      }]
    };
    const workspaces = new Map<string, { id: string; name: string; isArchived: boolean }>();

    const jsonlWriter: IJSONLWriter = {
      getDeviceId: jest.fn(() => 'mobile-device'),
      listFiles: jest.fn(async (category) => {
        if (category === 'workspaces') {
          return ['workspaces/ws_one.jsonl', 'workspaces/ws_two.jsonl'];
        }
        if (category === 'conversations') {
          return ['conversations/conv_one.jsonl', 'conversations/conv_two.jsonl'];
        }
        return ['tasks/project_one.jsonl', 'tasks/project_two.jsonl'];
      }),
      getFileModTime: jest.fn(async () => null),
      readEvents: jest.fn(async <T extends StorageEvent>(file: string): Promise<T[]> => {
        return (eventsByFile[file] ?? []) as T[];
      }),
      getEventsNotFromDevice: jest.fn(async () => [])
    };

    const sqliteCache: ISQLiteCacheManager = {
      getSyncState: jest.fn(async () => null),
      updateSyncState: jest.fn(async () => undefined),
      isEventApplied: jest.fn(async () => false),
      markEventApplied: jest.fn(async () => undefined),
      run: jest.fn(async (sql, params = []) => {
        if (sql.includes('INTO workspaces')) {
          workspaces.set(String(params[0]), {
            id: String(params[0]),
            name: String(params[1]),
            isArchived: params[7] === 1
          });
        }
        return { changes: 1, lastInsertRowid: 1 };
      }),
      query: jest.fn(async <T>(sql: string, params = []): Promise<T[]> => {
        if (sql.includes('FROM workspaces WHERE name = ? AND isArchived = 0')) {
          const name = String(params[0]);
          return Array.from(workspaces.values())
            .filter(workspace => workspace.name === name && !workspace.isArchived)
            .map(workspace => ({ id: workspace.id, lastAccessed: now })) as T[];
        }
        return [];
      }),
      queryOne: jest.fn(async <T>(sql: string, params = []): Promise<T | null> => {
        if (sql.includes('FROM workspaces WHERE id = ?')) {
          const id = String(params[0]);
          return workspaces.has(id) ? ({ id } as T) : null;
        }
        return null;
      }),
      clearAllData: jest.fn(async () => {
        workspaces.clear();
      }),
      rebuildFTSIndexes: jest.fn(async () => undefined),
      save: jest.fn(async () => undefined)
    };

    const coordinator = new SyncCoordinator(jsonlWriter, sqliteCache);
    const result = await coordinator.fullRebuild();

    expect(result.success).toBe(true);
    expect(result.eventsApplied).toBe(6);
    expect(result.filesProcessed).toHaveLength(6);
    expect(sqliteCache.markEventApplied).toHaveBeenCalledTimes(6);
    expect(sqliteCache.rebuildFTSIndexes).toHaveBeenCalledTimes(1);
    expect(sqliteCache.updateSyncState).toHaveBeenCalledTimes(1);
    expect(sqliteCache.save).toHaveBeenCalledTimes(1);
  });

  it('does not persist sync state or save a partial cache when full rebuild replay fails', async () => {
    const failingEvent: StorageEvent = {
      id: 'workspace-event-fails',
      type: 'workspace_created',
      deviceId: 'desktop-device',
      timestamp: 1_000,
      data: {
        id: 'workspace-fails',
        name: 'Workspace fails',
        rootFolder: '',
        created: 1_000
      }
    };

    const jsonlWriter: IJSONLWriter = {
      getDeviceId: jest.fn(() => 'mobile-device'),
      listFiles: jest.fn(async (category) => {
        return category === 'workspaces' ? ['workspaces/ws_fails.jsonl'] : [];
      }),
      getFileModTime: jest.fn(async () => null),
      readEvents: jest.fn(async <T extends StorageEvent>(): Promise<T[]> => [failingEvent as T]),
      getEventsNotFromDevice: jest.fn(async () => [])
    };

    const sqliteCache: ISQLiteCacheManager = {
      getSyncState: jest.fn(async () => null),
      updateSyncState: jest.fn(async () => undefined),
      isEventApplied: jest.fn(async () => false),
      markEventApplied: jest.fn(async () => undefined),
      run: jest.fn(async () => {
        throw new Error('workspace insert failed');
      }),
      query: jest.fn(async () => []),
      queryOne: jest.fn(async () => null),
      clearAllData: jest.fn(async () => undefined),
      rebuildFTSIndexes: jest.fn(async () => undefined),
      save: jest.fn(async () => undefined)
    };

    const coordinator = new SyncCoordinator(jsonlWriter, sqliteCache);
    const result = await coordinator.fullRebuild();

    expect(result.success).toBe(false);
    expect(result.errors.some(error => error.includes('workspace insert failed'))).toBe(true);
    expect(sqliteCache.rebuildFTSIndexes).not.toHaveBeenCalled();
    expect(sqliteCache.updateSyncState).not.toHaveBeenCalled();
    expect(sqliteCache.save).not.toHaveBeenCalled();
  });

  it('replays events from newly arrived files even when event timestamps are older than the last sync', async () => {
    const remoteEvent = {
      id: 'event-1',
      type: 'message',
      timestamp: 100,
      deviceId: 'desktop-device',
      conversationId: 'conv-1',
      data: {}
    };

    const jsonlWriter: IJSONLWriter = {
      getDeviceId: jest.fn(() => 'mobile-device'),
      listFiles: jest.fn(async (category) => {
        if (category === 'conversations') {
          return ['conversations/conv-1.jsonl'];
        }
        return [];
      }),
      getFileModTime: jest.fn(async (file) => file === 'conversations/conv-1.jsonl' ? 500 : null),
      readEvents: jest.fn(async () => []),
      getEventsNotFromDevice: jest.fn(async (file) =>
        file === 'conversations/conv-1.jsonl' ? [remoteEvent] : []
      )
    };

    const syncState: SyncState = {
      deviceId: 'mobile-device',
      lastEventTimestamp: 1000,
      fileTimestamps: {}
    };

    const sqliteCache: ISQLiteCacheManager = {
      getSyncState: jest.fn(async () => syncState),
      updateSyncState: jest.fn(async () => undefined),
      isEventApplied: jest.fn(async () => false),
      markEventApplied: jest.fn(async () => undefined),
      run: jest.fn(async () => ({ changes: 1, lastInsertRowid: 1 })),
      query: jest.fn(async () => []),
      queryOne: jest.fn(async () => null),
      clearAllData: jest.fn(async () => undefined),
      rebuildFTSIndexes: jest.fn(async () => undefined),
      save: jest.fn(async () => undefined)
    };

    const coordinator = new SyncCoordinator(jsonlWriter, sqliteCache);
    const result = await coordinator.sync();

    expect(result.success).toBe(true);
    expect(result.eventsApplied).toBe(1);
    expect(jsonlWriter.getEventsNotFromDevice).toHaveBeenCalledWith('conversations/conv-1.jsonl', 'mobile-device');
    expect(sqliteCache.markEventApplied).toHaveBeenCalledWith('event-1');
    expect(sqliteCache.updateSyncState).toHaveBeenCalledWith(
      'mobile-device',
      expect.any(Number),
      { 'conversations/conv-1.jsonl': 500 }
    );
  });
});
