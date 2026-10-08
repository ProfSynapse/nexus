/**
 * Failure bought: losing a view/process, an ambiguous POST, or crashing between
 * result delivery and acknowledgement must not lose the run or duplicate output.
 * Real job service/repository and registry drive a deterministic storage/HTTP
 * boundary. These tests prove scheduling and identity, not actual JSONL replay.
 */
import type { IStorageAdapter } from '../../../src/database/interfaces/IStorageAdapter';
import type { ConversationMetadata, MessageData } from '../../../src/types/storage/HybridStorageTypes';
import { RemoteAgentJobRepository, type RemoteAgentJob } from '../../../src/database/repositories/RemoteAgentJobRepository';
import { RemoteAgentJobService } from '../../../src/services/remoteAgents/RemoteAgentJobService';
import { RemoteAgentConnectionRegistry } from '../../../src/services/remoteAgents/RemoteAgentConnectionRegistry';
import { RemoteAgentError, type RemoteAgentConnection, type RemoteAgentConnector } from '../../../src/services/remoteAgents/types';

const RETENTION = 86_400_000;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fixture() {
  let clock = 1000;
  let sequence = 0;
  let failAck = false;
  const conversations = new Map<string, ConversationMetadata>([['parent', {
    id: 'parent', title: 'Parent', created: 1, updated: 1, vaultName: 'test', messageCount: 1,
  }]]);
  const messages = new Map<string, MessageData>([['origin', {
    id: 'origin', conversationId: 'parent', role: 'assistant', content: 'Delegating', state: 'complete', timestamp: 1, sequenceNumber: 0,
  }]]);
  const storage = {
    waitForQueryReady: jest.fn(async () => true),
    getConversation: jest.fn(async (id: string) => copy(conversations.get(id) ?? null)),
    getConversations: jest.fn(async (options: { page?: number; pageSize?: number }) => {
      const all = [...conversations.values()].sort((a, b) => a.id.localeCompare(b.id));
      const page = options.page ?? 0;
      const pageSize = options.pageSize ?? 25;
      return { items: copy(all.slice(page * pageSize, (page + 1) * pageSize)), page, pageSize,
        totalItems: all.length, totalPages: Math.ceil(all.length / pageSize),
        hasNextPage: (page + 1) * pageSize < all.length, hasPreviousPage: page > 0 };
    }),
    createConversation: jest.fn(async (data: Omit<ConversationMetadata, 'id' | 'messageCount'>) => {
      const id = `branch-${String(++sequence).padStart(4, '0')}`;
      conversations.set(id, copy({ ...data, id, messageCount: 0 }));
      return id;
    }),
    updateConversation: jest.fn(async (id: string, patch: Partial<ConversationMetadata>) => {
      if (failAck && (patch.metadata?.remoteAgentJob as RemoteAgentJob | undefined)?.deliveredAt !== undefined) {
        failAck = false;
        throw new Error('Crash before delivery acknowledgement');
      }
      const existing = conversations.get(id);
      if (!existing) throw new Error('Missing conversation');
      conversations.set(id, copy({ ...existing, ...patch }));
    }),
    getMessage: jest.fn(async (id: string) => copy(messages.get(id) ?? null)),
    addMessage: jest.fn(async (conversationId: string, data: Omit<MessageData, 'conversationId' | 'sequenceNumber'>) => {
      if (messages.has(data.id)) throw new Error('Duplicate message ID');
      messages.set(data.id, copy({ ...data, conversationId, sequenceNumber: messages.size }));
      return data.id;
    }),
    updateMessage: jest.fn(async (conversationId: string, id: string, patch: Partial<MessageData>) => {
      const existing = messages.get(id);
      if (!existing || existing.conversationId !== conversationId) throw new Error('Missing message');
      messages.set(id, copy({ ...existing, ...patch }));
    }),
    getMessages: jest.fn(() => { throw new Error('Job recovery must not scan full transcripts'); }),
  };
  const connections: RemoteAgentConnection[] = [{
    id: 'hermes-personal', displayName: 'My Hermes', connector: 'hermes', baseUrl: 'https://agent.example/v1', enabled: true, apiKey: 'secret-token',
  }];
  const connector: RemoteAgentConnector = {
    kind: 'hermes',
    probe: jest.fn(async () => ({ connected: true, runsAvailable: true, durableIdempotency: true,
      idempotencyRetentionMs: RETENTION, checkedAt: Date.now() })),
    submit: jest.fn(async () => ({ runId: 'run-1', state: 'running', remoteStatus: 'running' })),
    get: jest.fn(async () => ({ runId: 'run-1', state: 'completed', remoteStatus: 'completed', output: 'Remote answer' })),
    cancel: jest.fn(async () => ({ runId: 'run-1', state: 'cancelled', remoteStatus: 'cancelled' })),
  };
  const registry = new RemoteAgentConnectionRegistry(() => connections, [connector]);
  const service = () => new RemoteAgentJobService({
    repository: new RemoteAgentJobRepository(storage as unknown as IStorageAdapter), registry, vaultName: 'test', now: () => clock,
  });
  return { storage, conversations, messages, connector, registry, connections, service,
    advance: (milliseconds: number) => { clock += milliseconds; }, crashAck: () => { failAck = true; } };
}

const params = { target: 'hermes-personal', task: 'Find an answer', context: 'Explicit context', parentConversationId: 'parent', parentMessageId: 'origin', provider: 'openai', model: 'chosen-model', workspaceId: 'workspace', sessionId: 'session', agentPrompt: 'Parent prompt must not go to remote' };

describe('RemoteAgentJobService', () => {
  it('persists branch/request/key before POST and keeps credentials/Nexus instructions out of the job', async () => {
    const f = fixture();
    jest.mocked(f.connector.submit).mockImplementation(async (_connection, request, key) => {
      const persisted = [...f.conversations.values()].find(value => value.metadata?.remoteAgentJob);
      expect(persisted?.metadata?.remoteAgentJob).toEqual(expect.objectContaining({ idempotencyKey: key, state: 'submitting', submissionStartedAt: 1000 }));
      expect(request).toEqual({ input: 'Find an answer\n\nContext:\nExplicit context' });
      expect(JSON.stringify(persisted)).not.toContain('secret-token');
      return { runId: 'run-1', state: 'running', remoteStatus: 'running' };
    });
    const service = f.service();
    const result = await service.executeSubagent(params);
    await service.reconcile();
    expect(result.subagentId).toMatch(/^remote_/);
    const job = f.conversations.get(result.branchId)?.metadata?.remoteAgentJob as RemoteAgentJob;
    expect(job.runId).toBe('run-1');
    expect(job.parentOptions.model).toBe('chosen-model');
  });

  it('resumes polling through a new owner and delivers one labeled assistant reply to the originating chat', async () => {
    const f = fixture();
    const first = f.service();
    const created = await first.executeSubagent(params);
    await first.reconcile();
    await first.cleanup();
    f.advance(16_000);
    const restarted = f.service();
    await restarted.reconcile();
    await restarted.reconcile();
    await restarted.reconcile();
    const replies = [...f.messages.values()].filter(message => message.metadata?.type === 'subagent_result');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual(expect.objectContaining({ conversationId: 'parent', role: 'assistant', content: '[Remote agent "My Hermes" completed]\n\nRemote answer' }));
    expect(replies[0].metadata).toEqual(expect.objectContaining({ branchId: created.branchId, remoteTargetId: 'hermes-personal', runId: 'run-1' }));
    expect(f.connector.submit).toHaveBeenCalledTimes(1);
    expect(f.storage.getMessages).not.toHaveBeenCalled();
  });

  it('a crash after parent insertion but before acknowledgement cannot duplicate either result', async () => {
    const f = fixture();
    const service = f.service();
    await service.executeSubagent(params);
    await service.reconcile();
    f.advance(16_000);
    await service.reconcile();
    f.crashAck();
    await service.reconcile();
    await service.cleanup();
    const restarted = f.service();
    await restarted.reconcile();
    expect([...f.messages.values()].filter(message => message.metadata?.type === 'subagent_result')).toHaveLength(1);
    expect([...f.messages.values()].filter(message => message.role === 'assistant' && message.conversationId.startsWith('branch-'))).toHaveLength(1);
    const recoveredJob = [...f.conversations.values()].find(conversation => conversation.metadata?.remoteAgentJob)?.metadata?.remoteAgentJob as RemoteAgentJob;
    expect(recoveredJob.deliveredAt).toBeDefined();
  });

  it('retries an ambiguous submission with the same persisted key/request, but never beyond retention', async () => {
    const f = fixture();
    jest.mocked(f.connector.submit).mockRejectedValue(new RemoteAgentError('Disconnected', 'NETWORK', undefined, true));
    const first = f.service();
    await first.executeSubagent(params);
    await first.reconcile();
    const original = jest.mocked(f.connector.submit).mock.calls[0];
    await first.cleanup();
    f.advance(16_000);
    const second = f.service();
    await second.reconcile();
    expect(jest.mocked(f.connector.submit).mock.calls[1].slice(1, 3)).toEqual(original.slice(1, 3));
    await second.cleanup();
    f.advance(RETENTION);
    const expired = f.service();
    await expired.reconcile();
    expect(f.connector.submit).toHaveBeenCalledTimes(2);
    expect(expired.getAgentStatusList()[0].state).toBe('running');
    expect(JSON.stringify([...f.conversations.values()])).toContain('idempotency retention expired');
  });

  it('never rebinds a stored run to a newly edited URL', async () => {
    const f = fixture();
    const service = f.service();
    await service.executeSubagent(params);
    await service.reconcile();
    f.connections[0].baseUrl = 'https://another-agent.example/v1';
    f.advance(16_000);
    await service.reconcile();
    expect(f.connector.get).not.toHaveBeenCalled();
    expect(f.connector.submit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...f.conversations.values()])).toContain('will not be redirected');
  });

  it('drops deleted branches from its cached status roster and cannot stop a ghost job', async () => {
    const f = fixture();
    const service = f.service();
    const created = await service.executeSubagent(params);
    await service.reconcile();
    f.conversations.delete(created.branchId);
    await service.reconcile();
    expect(service.getAgentStatusList()).toEqual([]);
    await expect(service.cancelSubagent(created.subagentId)).resolves.toBe(false);
    expect(f.connector.cancel).not.toHaveBeenCalled();
  });

  it('keeps a newly accepted job when it was created after a recovery scan began', async () => {
    const f = fixture();
    const service = f.service();
    const original = f.storage.getConversations.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.storage.getConversations.mockImplementationOnce(async options => {
      const snapshot = await original(options);
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return snapshot;
    });
    const scanning = service.reconcile();
    await started;
    const created = await service.executeSubagent(params);
    release();
    await scanning;
    expect(service.getAgentStatusList().map(job => job.subagentId)).toEqual([created.subagentId]);
    await service.reconcile();
    expect(f.connector.submit).toHaveBeenCalledTimes(1);
  });

  it('Stop also tolerates a branch deleted before the next periodic roster refresh', async () => {
    const f = fixture();
    const service = f.service();
    const created = await service.executeSubagent(params);
    await service.reconcile();
    f.conversations.delete(created.branchId);
    await expect(service.cancelSubagent(created.subagentId)).resolves.toBe(false);
    expect(service.getAgentStatusList()).toEqual([]);
    expect(f.connector.cancel).not.toHaveBeenCalled();
  });

  it('a Stop persisted while the initial health refresh is pending prevents the first POST', async () => {
    const f = fixture();
    const service = f.service();
    const originalHealth = f.registry.getHealth.bind(f.registry);
    let healthReads = 0;
    jest.spyOn(f.registry, 'getHealth').mockImplementation(id => {
      healthReads++;
      return healthReads === 2 ? undefined : originalHealth(id);
    });
    const healthy = { connected: true, runsAvailable: true, durableIdempotency: true,
      idempotencyRetentionMs: RETENTION, checkedAt: Date.now() };
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    jest.mocked(f.connector.probe).mockResolvedValueOnce(healthy).mockImplementationOnce(async () => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return healthy;
    });
    const created = await service.executeSubagent(params);
    await started;
    await service.cancelSubagent(created.subagentId);
    expect((f.conversations.get(created.branchId)?.metadata?.remoteAgentJob as RemoteAgentJob).cancelRequestedAt).toBeDefined();
    release();
    await service.reconcile();
    expect(f.connector.submit).not.toHaveBeenCalled();
    expect(service.getAgentStatusList()[0].state).toBe('cancelled');
  });

  it('cannot replay an ambiguous POST under a different API credential on the same URL', async () => {
    const f = fixture();
    jest.mocked(f.connector.submit).mockRejectedValue(new RemoteAgentError('Disconnected', 'NETWORK', undefined, true));
    const first = f.service();
    await first.executeSubagent(params);
    await first.reconcile();
    await first.cleanup();
    f.connections[0].apiKey = 'another-scope';
    f.advance(16_000);
    const restarted = f.service();
    await restarted.reconcile();
    expect(f.connector.submit).toHaveBeenCalledTimes(1);
    expect(restarted.getAgentStatusList()[0].remoteStatus).toBe('needs_attention');
    const stored = JSON.stringify([...f.conversations.values()]);
    expect(stored).not.toContain('another-scope');
    expect(stored).not.toContain('secret-token');
    expect(stored).toContain('credential scope');
  });

  it('accepts a durably created job even if its task message needs a later retry', async () => {
    const f = fixture();
    f.storage.addMessage.mockRejectedValueOnce(new Error('Temporary message write failure'));
    const service = f.service();
    const accepted = await service.executeSubagent(params);
    await service.reconcile();
    expect(accepted.branchId).toBe('branch-0001');
    await service.reconcile();
    expect(f.connector.submit).toHaveBeenCalledTimes(1);
    expect(f.storage.createConversation).toHaveBeenCalledTimes(1);
  });

  it('cleanup waits for submission mutations and prevents branch writes after a cold-storage wait', async () => {
    const f = fixture();
    let release!: (ready: boolean) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.storage.waitForQueryReady.mockImplementationOnce(() => {
      entered();
      return new Promise<boolean>(resolve => { release = resolve; });
    });
    const service = f.service();
    const submitting = service.executeSubagent(params);
    const rejected = expect(submitting).rejects.toThrow('interrupted before persistence');
    await started;
    let closed = false;
    const closing = service.cleanup().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release(true);
    await rejected;
    await closing;
    expect(f.storage.createConversation).not.toHaveBeenCalled();
    expect(f.connector.submit).not.toHaveBeenCalled();
  });

  it('coalesces concurrent reconcile ticks while a remote status request is outstanding', async () => {
    const f = fixture();
    const service = f.service();
    await service.executeSubagent(params);
    await service.reconcile();
    f.advance(16_000);
    let release!: (value: Awaited<ReturnType<RemoteAgentConnector['get']>>) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    jest.mocked(f.connector.get).mockImplementationOnce(() => {
      entered();
      return new Promise(resolve => { release = resolve; });
    });
    const first = service.reconcile();
    await started;
    expect(service.reconcile()).toBe(first);
    expect(f.connector.get).toHaveBeenCalledTimes(1);
    release({ runId: 'run-1', state: 'completed', remoteStatus: 'completed', output: 'Done' });
    await first;
  });

  it('cleanup also waits for a cancellation-intent write before storage can close', async () => {
    const f = fixture();
    const service = f.service();
    const created = await service.executeSubagent(params);
    await service.reconcile();
    const original = f.storage.updateConversation.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.storage.updateConversation.mockImplementationOnce(async (id, patch) => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      await original(id, patch);
    });
    const cancelling = service.cancelSubagent(created.subagentId);
    await started;
    let closed = false;
    const closing = service.cleanup().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    expect(await cancelling).toBe(true);
    await closing;
    expect((f.conversations.get(created.branchId)?.metadata?.remoteAgentJob as RemoteAgentJob).cancelRequestedAt).toBe(1000);
    expect(f.connector.cancel).not.toHaveBeenCalled();
  });

  it('remote approval states remain outstanding and have a durable explanation without automatic approval', async () => {
    const f = fixture();
    const service = f.service();
    await service.executeSubagent(params);
    await service.reconcile();
    f.advance(16_000);
    jest.mocked(f.connector.get).mockResolvedValueOnce({ runId: 'run-1', state: 'needs_attention', remoteStatus: 'waiting_approval' });
    await service.reconcile();
    expect(service.getAgentStatusList()[0]).toEqual(expect.objectContaining({ state: 'running', remoteStatus: 'needs_attention' }));
    expect([...f.messages.values()].some(message => message.content?.includes('Nexus does not approve'))).toBe(true);
    expect(f.connector.cancel).not.toHaveBeenCalled();
    expect(f.connector.submit).toHaveBeenCalledTimes(1);
  });

  it('the initial storage-not-ready error keeps the periodic recovery retry alive', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const service = f.service();
    try {
      f.storage.waitForQueryReady.mockResolvedValueOnce(false);
      await expect(service.start()).rejects.toThrow('storage is rebuilding');
      jest.advanceTimersByTime(15_000);
      await service.reconcile();
      expect(f.storage.waitForQueryReady).toHaveBeenCalledTimes(2);
    } finally {
      await service.cleanup();
      jest.useRealTimers();
    }
  });

  it('persists cancellation intent and retries a failed stop after restart', async () => {
    const f = fixture();
    const first = f.service();
    const created = await first.executeSubagent(params);
    await first.reconcile();
    jest.mocked(f.connector.cancel).mockRejectedValueOnce(new RemoteAgentError('Disconnected', 'NETWORK'));
    await first.cancelSubagent(created.subagentId);
    await first.reconcile();
    const job = f.conversations.get(created.branchId)?.metadata?.remoteAgentJob as RemoteAgentJob;
    expect(job.cancelRequestedAt).toBe(1000);
    await first.cleanup();
    f.advance(16_000);
    const second = f.service();
    await second.reconcile();
    await second.reconcile();
    expect(f.connector.cancel).toHaveBeenCalledTimes(2);
    expect(second.getAgentStatusList()[0].state).toBe('cancelled');
  });

  it('cancellation of an ambiguous POST cannot create a new run just to discover its identity', async () => {
    const f = fixture();
    jest.mocked(f.connector.submit).mockRejectedValue(new RemoteAgentError('Disconnected', 'NETWORK', undefined, true));
    const service = f.service();
    const created = await service.executeSubagent(params);
    await service.reconcile();
    await service.cancelSubagent(created.subagentId);
    await service.reconcile();
    expect(f.connector.submit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...f.conversations.values()])).toContain('Nexus will not start a new run');
  });

  it('rejects missing/foreign origin messages before creating a branch or submitting', async () => {
    const f = fixture();
    const service = f.service();
    await expect(service.executeSubagent({ ...params, parentMessageId: 'absent' })).rejects.toThrow('Originating message');
    expect(f.storage.createConversation).not.toHaveBeenCalled();
    expect(f.connector.submit).not.toHaveBeenCalled();
  });

  it('recovery awaits readiness and pages every branch with stable ID order rather than only the latest hundred', async () => {
    const f = fixture();
    const first = f.service();
    await first.executeSubagent(params);
    await first.reconcile();
    await first.cleanup();
    for (let index = 0; index < 430; index++) {
      f.conversations.set(`noise-${index}`, { id: `noise-${index}`, title: 'Other conversation', created: 1, updated: 999999, vaultName: 'test', messageCount: 0 });
    }
    f.storage.getConversations.mockClear();
    f.advance(16_000);
    const service = f.service();
    await service.reconcile();
    expect(f.storage.waitForQueryReady).toHaveBeenCalled();
    expect(f.storage.getConversations.mock.calls.map(([options]) => options)).toEqual([
      { includeBranches: true, page: 0, pageSize: 200, sortBy: 'id', sortOrder: 'asc' },
      { includeBranches: true, page: 1, pageSize: 200, sortBy: 'id', sortOrder: 'asc' },
      { includeBranches: true, page: 2, pageSize: 200, sortBy: 'id', sortOrder: 'asc' },
    ]);
    expect(service.getAgentStatusList()).toHaveLength(1);
    expect(f.connector.get).toHaveBeenCalledTimes(1);
  });
});
