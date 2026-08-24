import {
  ToolOperationService,
  createToolOperationSignature,
} from '../../src/agents/toolManager/services/ToolOperationService';
import type { IToolOperationRepository } from '../../src/database/repositories/interfaces/IToolOperationRepository';
import type {
  StartToolOperationData,
  ToolOperationReceipt,
} from '../../src/types/tools/ToolOperationTypes';

function createRepository(initial?: ToolOperationReceipt): jest.Mocked<IToolOperationRepository> {
  let receipt = initial ?? null;
  return {
    getById: jest.fn(async () => receipt),
    start: jest.fn(async (data: StartToolOperationData) => {
      receipt = {
        ...data,
        status: 'started',
        resultTruncated: false,
        startedAt: 1,
        updatedAt: 1,
      };
      return true;
    }),
    complete: jest.fn(async data => {
      if (receipt) receipt = {
        ...receipt,
        status: 'completed',
        resultJson: data.resultJson,
        resultTruncated: data.resultTruncated,
        completedAt: 2,
        updatedAt: 2,
      };
    }),
    fail: jest.fn(async data => {
      if (receipt) receipt = { ...receipt, status: 'failed', error: data.error, completedAt: 2, updatedAt: 2 };
    }),
    markIndeterminate: jest.fn(async data => {
      if (receipt) receipt = { ...receipt, status: 'indeterminate', error: data.error, completedAt: 2, updatedAt: 2 };
    }),
  };
}

const baseInput = {
  operationId: 'provider-call-1:0',
  origin: 'native-chat' as const,
  replayable: true,
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  conversationId: 'conversation-1',
  messageId: 'message-1',
  turnId: 'message-1',
  agent: 'contentManager',
  tool: 'write',
  params: { path: 'Notes/a.md', content: 'hello' },
  replayPolicy: 'deduplicate' as const,
};

function createService(repository: IToolOperationRepository): ToolOperationService {
  return new ToolOperationService(async () => ({
    isReady: () => true,
    waitForQueryReady: async () => true,
    operations: repository,
  }));
}

describe('ToolOperationService', () => {
  it('persists started before dispatch and suppresses an exact completed retry', async () => {
    const repository = createRepository();
    const service = createService(repository);
    const dispatch = jest.fn(async () => ({
      agent: 'contentManager', tool: 'write', success: true, data: { path: 'Notes/a.md' }
    }));

    const first = await service.execute(baseInput, dispatch);
    const second = await service.execute(baseInput, dispatch);

    expect(first.success).toBe(true);
    expect(second).toEqual({
      agent: 'contentManager', tool: 'write', success: true, data: { path: 'Notes/a.md' }, error: undefined
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(repository.start.mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[0]);
    expect(repository.complete).toHaveBeenCalledTimes(1);
  });

  it('rejects the same operation id with a different canonical signature', async () => {
    const repository = createRepository();
    const service = createService(repository);
    const dispatch = jest.fn(async () => ({ agent: 'contentManager', tool: 'write', success: true }));
    await service.execute(baseInput, dispatch);

    const result = await service.execute({
      ...baseInput,
      params: { path: 'Notes/b.md', content: 'different' },
    }, dispatch);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Operation ID conflict/);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent exact retries in-process', async () => {
    const repository = createRepository();
    const service = createService(repository);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const dispatch = jest.fn(async () => {
      await gate;
      return { agent: 'contentManager', tool: 'write', success: true, data: { path: 'Notes/a.md' } };
    });

    const first = service.execute(baseInput, dispatch);
    const retry = service.execute(baseInput, dispatch);
    release();
    const [firstResult, retryResult] = await Promise.all([first, retry]);

    expect(firstResult).toEqual(retryResult);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(repository.start).toHaveBeenCalledTimes(1);
  });

  it('retries an interrupted safe operation but refuses a deduplicate operation without reconciliation', async () => {
    const safeSignature = await createToolOperationSignature({
      workspaceId: baseInput.workspaceId,
      agent: baseInput.agent,
      tool: 'read',
      params: { path: 'Notes/a.md' },
    });
    const safeReceipt: ToolOperationReceipt = {
      signature: safeSignature,
      operationId: 'safe-read:0',
      origin: baseInput.origin,
      workspaceId: baseInput.workspaceId,
      sessionId: baseInput.sessionId,
      conversationId: baseInput.conversationId,
      messageId: baseInput.messageId,
      turnId: baseInput.turnId,
      commandSummary: 'contentManager read',
      replayPolicy: 'safe',
      replayable: true,
      status: 'started',
      resultTruncated: false,
      startedAt: 1,
      updatedAt: 1,
    };
    const safeRepo = createRepository(safeReceipt);
    const safeDispatch = jest.fn(async () => ({ agent: 'contentManager', tool: 'read', success: true, data: 'hello' }));
    const safeResult = await createService(safeRepo).execute({
      ...baseInput,
      operationId: 'safe-read:0',
      tool: 'read',
      params: { path: 'Notes/a.md' },
      replayPolicy: 'safe',
    }, safeDispatch);
    expect(safeResult.success).toBe(true);
    expect(safeDispatch).toHaveBeenCalledTimes(1);

    const writeSignature = await createToolOperationSignature(baseInput);
    const writeRepo = createRepository({
      operationId: baseInput.operationId,
      signature: writeSignature,
      origin: baseInput.origin,
      workspaceId: baseInput.workspaceId,
      sessionId: baseInput.sessionId,
      replayPolicy: 'deduplicate',
      replayable: true,
      commandSummary: 'contentManager write',
      status: 'started',
      resultTruncated: false,
      startedAt: 1,
      updatedAt: 1,
    });
    const writeDispatch = jest.fn(async () => ({ agent: 'contentManager', tool: 'write', success: true }));
    const writeResult = await createService(writeRepo).execute(baseInput, writeDispatch);
    expect(writeResult.success).toBe(false);
    expect(writeResult.error).toMatch(/indeterminate/);
    expect(writeDispatch).not.toHaveBeenCalled();
    expect(writeRepo.markIndeterminate).toHaveBeenCalledTimes(1);
  });

  it('excludes volatile context from signatures and redacts secrets in bounded recorded results', async () => {
    const one = await createToolOperationSignature({
      workspaceId: 'w', agent: 'searchManager', tool: 'content',
      params: { query: 'x', sessionId: 'one', context: { goal: 'a' } },
    });
    const two = await createToolOperationSignature({
      workspaceId: 'w', agent: 'searchManager', tool: 'content',
      params: { context: { goal: 'b' }, sessionId: 'two', query: 'x' },
    });
    expect(one).toBe(two);

    const repository = createRepository();
    await createService(repository).execute(
      { ...baseInput, operationId: 'secret-result:0' },
      async () => ({
        agent: 'contentManager', tool: 'write', success: true,
        data: { apiKey: 'top-secret', body: 'x'.repeat(50_000) },
      })
    );
    const completed = repository.complete.mock.calls[0][0];
    expect(completed.resultJson).not.toContain('top-secret');
    expect(new TextEncoder().encode(completed.resultJson).byteLength).toBeLessThanOrEqual(32 * 1024);
    expect(completed.resultTruncated).toBe(true);
  });

  it('keeps multibyte and escaped result receipts within the UTF-8 byte limit', async () => {
    const repository = createRepository();
    await createService(repository).execute(
      { ...baseInput, operationId: 'unicode-result:0' },
      async () => ({
        agent: 'contentManager', tool: 'write', success: true,
        data: { body: '🧪"\\'.repeat(20_000) },
      })
    );

    const completed = repository.complete.mock.calls[0][0];
    expect(new TextEncoder().encode(completed.resultJson).byteLength).toBeLessThanOrEqual(32 * 1024);
    expect(() => JSON.parse(completed.resultJson)).not.toThrow();
    expect(completed.resultTruncated).toBe(true);
  });

  it('allows only one owner to dispatch after two unsynchronized reads', async () => {
    let receipt: ToolOperationReceipt | null = null;
    let reads = 0;
    let releaseReads!: () => void;
    const bothRead = new Promise<void>(resolve => { releaseReads = resolve; });
    const repository: IToolOperationRepository = {
      getById: jest.fn(async () => {
        reads++;
        if (reads <= 2) {
          if (reads === 2) releaseReads();
          await bothRead;
          return null;
        }
        return receipt;
      }),
      start: jest.fn(async data => {
        if (receipt) return false;
        receipt = { ...data, status: 'started', resultTruncated: false, startedAt: 1, updatedAt: 1 };
        return true;
      }),
      complete: jest.fn(async data => {
        if (receipt) receipt = { ...receipt, status: 'completed', resultJson: data.resultJson, resultTruncated: data.resultTruncated, updatedAt: 2 };
      }),
      fail: jest.fn(async () => undefined),
      markIndeterminate: jest.fn(async () => undefined),
    };
    const firstOwner = new ToolOperationService(async () => ({ isReady: () => true, operations: repository }), new Map());
    const secondOwner = new ToolOperationService(async () => ({ isReady: () => true, operations: repository }), new Map());
    const dispatch = jest.fn(async () => ({ agent: 'contentManager', tool: 'write', success: true }));

    const results = await Promise.all([
      firstOwner.execute(baseInput, dispatch),
      secondOwner.execute(baseInput, dispatch),
    ]);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(results.filter(result => result.success)).toHaveLength(1);
    expect(results.find(result => !result.success)?.error).toMatch(/already running/);
  });
});
