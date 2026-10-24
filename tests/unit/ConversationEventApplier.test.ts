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

  it('replays the complete compaction checkpoint and schema references in metadata-only updates', async () => {
    const sqliteCache = { run: jest.fn(async (_sql: string, _params: unknown[]) => undefined) };
    const applier = new ConversationEventApplier(sqliteCache);
    const settings = { chatSettings: { workspaceId: 'ws', sessionId: 'session' }, compaction: { frontier: [{
      summary: 'restoration text', savedState: { name: 'Saved checkpoint', conversationContext: 'full restoration text', activeTask: 'Current task', activeFiles: ['Exact path.md'], nextSteps: ['Verify'] },
      toolSelectors: ['content read'], retainedTokensAtCompaction: 123, boundaryMessageId: 'm20', boundaryMode: 'after'
    }] } };
    await applier.apply({ id: 'event-checkpoint', type: 'conversation_updated', deviceId: 'device', timestamp: 1, conversationId: 'conv', data: { settings } });
    const [sql, params] = sqliteCache.run.mock.calls[0];
    expect(sql).toContain('metadataJson = ?');
    expect(JSON.parse(params[0] as string)).toEqual(settings);
    expect(params).toContain('ws');
    expect(params).toContain('session');
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
