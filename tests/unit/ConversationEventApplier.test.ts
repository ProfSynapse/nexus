import { ConversationEventApplier } from '../../src/database/sync/ConversationEventApplier';

type SqliteCacheLike = {
  run: jest.Mock<Promise<void>, [string, unknown[]]>;
};

describe('ConversationEventApplier', () => {
  it.each([
    { type: 'subagent_result', remoteJobId: 'job-1', branchId: 'branch-1', details: { success: true } },
    undefined
  ])('replays message metadata including legacy events without it (%j)', async metadata => {
    const sqliteCache = { run: jest.fn(async (_sql: string, _params: unknown[]) => undefined) };
    const applier = new ConversationEventApplier(sqliteCache);
    const event = {
      id: 'evt-message-1', type: 'message' as const, deviceId: 'device-1', timestamp: 123456,
      conversationId: 'conv-1',
      data: { id: 'msg-1', role: 'assistant' as const, content: 'Remote reply', sequenceNumber: 1, metadata }
    };

    await applier.apply(event);

    const [sql, values] = sqliteCache.run.mock.calls[0];
    const columns = /\(([^)]+)\)/.exec(sql)?.[1].split(',').map(column => column.trim()) ?? [];
    expect(columns).toContain('metadataJson');
    expect(values).toHaveLength(columns.length);
    expect(values[columns.indexOf('metadataJson')]).toEqual(metadata ? JSON.stringify(metadata) : null);
  });

  it('applies message_deleted events to SQLite cache', async () => {
    const sqliteCache = {
      run: jest.fn(async () => undefined)
    };

    const applier = new ConversationEventApplier(sqliteCache as SqliteCacheLike);

    await applier.apply({
      id: 'evt-delete-1',
      type: 'message_deleted',
      deviceId: 'device-1',
      timestamp: 123456,
      conversationId: 'conv-1',
      messageId: 'msg-2'
    });

    expect(sqliteCache.run).toHaveBeenNthCalledWith(
      1,
      'DELETE FROM messages WHERE id = ? AND conversationId = ?',
      ['msg-2', 'conv-1']
    );
    expect(sqliteCache.run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE conversations'),
      [123456, 'conv-1']
    );
  });
});
