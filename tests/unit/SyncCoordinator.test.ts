import { SyncCoordinator, type IJSONLWriter, type ISQLiteCacheManager, type SyncState } from '../../src/database/sync/SyncCoordinator';

describe('SyncCoordinator', () => {
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
