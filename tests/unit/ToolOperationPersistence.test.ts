import { ToolOperationRepository } from '../../src/database/repositories/ToolOperationRepository';
import { WorkspaceEventApplier } from '../../src/database/sync/WorkspaceEventApplier';
import type { ToolOperationStartedEvent } from '../../src/database/interfaces/StorageEvents';

describe('durable tool operation persistence', () => {
  it('writes the started event to the workspace stream before applying SQLite', async () => {
    const order: string[] = [];
    const jsonlWriter = {
      appendEvent: jest.fn(async (_path: string, data: Omit<ToolOperationStartedEvent, 'id' | 'deviceId' | 'timestamp'>) => {
        order.push('jsonl');
        return { ...data, id: 'event-1', deviceId: 'device-1', timestamp: 1000 };
      }),
    };
    const sqliteCache = {
      queryOne: jest.fn(async () => null),
      run: jest.fn(async () => { order.push('sqlite'); return { changes: 1, lastInsertRowid: 1 }; }),
    };
    const queryCache = { clear: jest.fn() };
    const repository = new ToolOperationRepository({
      jsonlWriter,
      sqliteCache,
      queryCache,
    } as never);

    await repository.start({
      operationId: 'op-1:0',
      signature: 'abc',
      origin: 'external-mcp',
      workspaceId: 'default',
      sessionId: 'nexus-cli',
      replayPolicy: 'deduplicate',
      replayable: true,
      commandSummary: 'contentManager write',
    });

    expect(order).toEqual(['jsonl', 'sqlite']);
    expect(jsonlWriter.appendEvent).toHaveBeenCalledWith(
      'workspaces/ws_default.jsonl',
      expect.objectContaining({ type: 'tool_operation_started', workspaceId: 'default' })
    );
    expect(sqliteCache.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO tool_operation_receipts'),
      expect.arrayContaining(['op-1:0', 'abc', 'external-mcp', 'default'])
    );
    expect(queryCache.clear).toHaveBeenCalledTimes(1);
  });

  it('applies terminal events only when operation id and signature both match', async () => {
    const sqliteCache = { run: jest.fn(async () => undefined) };
    const applier = new WorkspaceEventApplier(sqliteCache as never);

    await applier.apply({
      id: 'event-2',
      deviceId: 'device-1',
      timestamp: 2000,
      type: 'tool_operation_completed',
      workspaceId: 'workspace-1',
      operationId: 'op-1:0',
      signature: 'abc',
      resultJson: '{"success":true}',
      resultTruncated: false,
      completedAt: 1999,
    });

    expect(sqliteCache.run).toHaveBeenCalledWith(
      expect.stringContaining('WHERE operationId = ? AND signature = ?'),
      ['completed', '{"success":true}', 0, null, 1999, 2000, 'op-1:0', 'abc']
    );
  });

  it('repairs a missing SQLite receipt from the authoritative workspace stream', async () => {
    const jsonlWriter = {
      getFileModTime: jest.fn(async () => 10),
      readEvents: jest.fn(async () => [
        {
          id: 'event-1', deviceId: 'device-1', timestamp: 1000,
          type: 'tool_operation_started', workspaceId: 'default',
          data: {
            operationId: 'op-1:0', signature: 'abc', origin: 'external-mcp',
            workspaceId: 'default', sessionId: 'nexus-cli', replayPolicy: 'deduplicate',
            replayable: true, commandSummary: 'contentManager write',
          },
        },
        {
          id: 'event-2', deviceId: 'device-1', timestamp: 1001,
          type: 'tool_operation_completed', workspaceId: 'default',
          operationId: 'op-1:0', signature: 'abc', resultJson: '{"success":true}',
          resultTruncated: false, completedAt: 1001,
        },
      ]),
    };
    const sqliteCache = {
      queryOne: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          operationId: 'op-1:0', signature: 'abc', status: 'completed',
          origin: 'external-mcp', workspaceId: 'default', sessionId: 'nexus-cli',
          replayPolicy: 'deduplicate', replayable: 1, commandSummary: 'contentManager write',
          resultJson: '{"success":true}', resultTruncated: 0,
          startedAt: 1000, completedAt: 1001, updatedAt: 1001,
        }),
      run: jest.fn(async () => undefined),
    };
    const queryCache = { clear: jest.fn() };
    const repository = new ToolOperationRepository({ jsonlWriter, sqliteCache, queryCache } as never);

    const receipt = await repository.getById('op-1:0', 'default');

    expect(jsonlWriter.readEvents).toHaveBeenCalledWith('workspaces/ws_default.jsonl');
    expect(sqliteCache.run).toHaveBeenCalledTimes(2);
    expect(queryCache.clear).toHaveBeenCalledTimes(1);
    expect(receipt).toEqual(expect.objectContaining({ operationId: 'op-1:0', status: 'completed' }));
  });

  it('reuses the workspace event index while the JSONL modtime is unchanged', async () => {
    const jsonlWriter = {
      getFileModTime: jest.fn(async () => 10),
      readEvents: jest.fn(async () => []),
    };
    const sqliteCache = { queryOne: jest.fn(async () => null), run: jest.fn(async () => undefined) };
    const repository = new ToolOperationRepository({
      jsonlWriter,
      sqliteCache,
      queryCache: { clear: jest.fn() },
    } as never);

    await repository.getById('missing-1', 'default');
    await repository.getById('missing-2', 'default');

    expect(jsonlWriter.readEvents).toHaveBeenCalledTimes(1);
  });
});
