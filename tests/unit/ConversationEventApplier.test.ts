import { ConversationEventApplier } from '../../src/database/sync/ConversationEventApplier';

type SqliteCacheLike = {
  run: jest.Mock<Promise<void>, [string, unknown[]]>;
};

describe('ConversationEventApplier', () => {
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
