import type { IStorageAdapter } from '../interfaces/IStorageAdapter';
import type { ConversationMetadata, MessageData } from '../../types/storage/HybridStorageTypes';
import type { SubagentParams, BranchState } from '../../types/branch/BranchTypes';
import type { RemoteAgentRequest } from '../../services/remoteAgents/types';

export type RemoteJobState = 'pending_submission' | 'submitting' | 'running' | 'attention' | 'completed' | 'failed' | 'cancelled';

/** Credentials never belong in this replayable record. */
export interface RemoteAgentJob {
  schemaVersion: 1;
  jobId: string;
  branchId: string;
  targetId: string;
  targetName: string;
  endpointFingerprint: string;
  credentialFingerprint: string;
  task: string;
  parentConversationId: string;
  originatingMessageId: string;
  parentOptions: Pick<SubagentParams, 'provider' | 'model' | 'workspaceId' | 'sessionId' | 'agentPrompt' | 'thinkingEnabled' | 'thinkingEffort'>;
  request: RemoteAgentRequest;
  idempotencyKey: string;
  state: RemoteJobState;
  remoteStatus: string;
  createdAt: number;
  updatedAt: number;
  submissionStartedAt?: number;
  idempotencyRetentionMs?: number;
  runId?: string;
  remoteSessionId?: string;
  output?: string;
  error?: string;
  cancelRequestedAt?: number;
  nextPollAt?: number;
  branchResultMessageId: string;
  parentResultMessageId: string;
  deliveredAt?: number;
  notifiedAt?: number;
  failureCount?: number;
}

export function remoteJobBranchState(job: RemoteAgentJob): BranchState {
  if (job.state === 'completed') return 'complete';
  if (job.state === 'cancelled') return 'cancelled';
  if (job.state === 'failed') return 'abandoned';
  return 'running';
}

function readJob(conversation: ConversationMetadata): RemoteAgentJob | null {
  const value = conversation.metadata?.remoteAgentJob;
  if (!value || typeof value !== 'object') return null;
  const job = value as Partial<RemoteAgentJob>;
  if (job.schemaVersion !== 1 || typeof job.jobId !== 'string' || typeof job.targetId !== 'string'
    || typeof job.parentConversationId !== 'string' || typeof job.idempotencyKey !== 'string'
    || !job.request || typeof job.request.input !== 'string' || typeof job.state !== 'string') return null;
  return { ...job, branchId: conversation.id } as RemoteAgentJob;
}

/** Uses existing conversation events, so normal JSONL replay restores jobs. */
export class RemoteAgentJobRepository {
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(private readonly storage: IStorageAdapter) {}

  async ready(): Promise<void> {
    if (this.storage.waitForQueryReady && !await this.storage.waitForQueryReady()) {
      throw new Error('Remote jobs cannot be recovered while storage is rebuilding.');
    }
    if (!this.storage.getMessage) throw new Error('Remote jobs require exact message lookup for safe delivery.');
  }

  async create(job: Omit<RemoteAgentJob, 'branchId'>, vaultName: string, signal?: AbortSignal): Promise<RemoteAgentJob> {
    await this.ready();
    if (signal?.aborted) throw new Error('Remote submission was interrupted before persistence.');
    if (!await this.storage.getConversation(job.parentConversationId)) throw new Error('Parent conversation no longer exists.');
    const origin = await this.storage.getMessage!(job.originatingMessageId);
    if (!origin || origin.conversationId !== job.parentConversationId) throw new Error('Originating message does not belong to the parent conversation.');
    if (signal?.aborted) throw new Error('Remote submission was interrupted before persistence.');
    const branchId = await this.storage.createConversation({
      title: `Remote agent: ${job.task.slice(0, 80)}`, vaultName,
      created: job.createdAt, updated: job.updatedAt,
      workspaceId: job.parentOptions.workspaceId, sessionId: job.parentOptions.sessionId,
      metadata: {
        parentConversationId: job.parentConversationId, parentMessageId: job.originatingMessageId,
        branchType: 'subagent', inheritContext: false, remoteAgentJob: job,
        subagent: { task: job.task, subagentId: job.jobId, state: 'running', iterations: 0,
          maxIterations: 1, startedAt: job.createdAt, remoteTargetId: job.targetId, remoteStatus: job.remoteStatus },
      },
    });
    return { ...job, branchId };
  }

  async list(): Promise<RemoteAgentJob[]> {
    await this.ready();
    const jobs: RemoteAgentJob[] = [];
    for (let page = 0; ; page++) {
      // Stable ID ordering is unaffected by status updates during recovery.
      const result = await this.storage.getConversations({ includeBranches: true, page, pageSize: 200, sortBy: 'id', sortOrder: 'asc' });
      for (const conversation of result.items) {
        const job = readJob(conversation);
        if (job) jobs.push(job);
      }
      if (!result.hasNextPage) break;
    }
    return jobs;
  }

  async get(branchId: string): Promise<RemoteAgentJob | null> {
    const conversation = await this.storage.getConversation(branchId);
    return conversation ? readJob(conversation) : null;
  }

  async update(branchId: string, patch: Partial<RemoteAgentJob>): Promise<RemoteAgentJob> {
    const pending = (this.writes.get(branchId) ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.applyUpdate(branchId, patch));
    this.writes.set(branchId, pending);
    try { return await pending; }
    finally { if (this.writes.get(branchId) === pending) this.writes.delete(branchId); }
  }

  private async applyUpdate(branchId: string, patch: Partial<RemoteAgentJob>): Promise<RemoteAgentJob> {
    const conversation = await this.storage.getConversation(branchId);
    const existing = conversation && readJob(conversation);
    if (!conversation || !existing) throw new Error('Remote job branch no longer exists.');
    const job = { ...existing, ...patch, branchId, jobId: existing.jobId };
    await this.storage.updateConversation(branchId, {
      updated: job.updatedAt,
      metadata: { ...conversation.metadata, remoteAgentJob: job,
        subagent: { ...(conversation.metadata?.subagent as Record<string, unknown> | undefined),
          task: job.task, subagentId: job.jobId, state: remoteJobBranchState(job), remoteStatus: job.remoteStatus,
          error: job.error, completedAt: ['completed', 'failed', 'cancelled'].includes(job.state) ? job.updatedAt : undefined },
      },
    });
    return job;
  }

  private async ensureMessage(conversationId: string, message: Omit<MessageData, 'conversationId' | 'sequenceNumber'>): Promise<void> {
    if (!this.storage.getMessage) throw new Error('Exact message lookup is unavailable.');
    const existing = await this.storage.getMessage(message.id);
    if (existing) {
      if (existing.conversationId !== conversationId) throw new Error('Remote result message identity collision.');
      return;
    }
    await this.storage.addMessage(conversationId, message);
  }

  async ensureTaskMessage(job: RemoteAgentJob): Promise<void> {
    await this.ensureMessage(job.branchId, { id: `${job.jobId}-task`, role: 'user', content: job.request.input,
      timestamp: job.createdAt, state: 'complete', metadata: { remoteJobId: job.jobId } });
  }

  async ensureAttentionMessage(job: RemoteAgentJob): Promise<void> {
    if (!this.storage.getMessage) throw new Error('Exact message lookup is unavailable.');
    const id = `${job.jobId}-attention`;
    const content = job.error || 'Remote agent needs attention. Check the remote agent; Nexus does not approve its requests automatically.';
    const existing = await this.storage.getMessage(id);
    if (existing) {
      if (existing.conversationId !== job.branchId) throw new Error('Remote status message identity collision.');
      if (existing.content !== content) await this.storage.updateMessage(job.branchId, id, { content });
    } else await this.ensureMessage(job.branchId, { id, role: 'assistant', content, state: 'complete', timestamp: job.updatedAt,
      metadata: { remoteJobId: job.jobId, remoteStatus: 'needs_attention', isAutoGenerated: true } });
  }

  async deliver(job: RemoteAgentJob): Promise<void> {
    const content = job.output || job.error || `Remote task ${job.state}.`;
    await this.ensureMessage(job.branchId, { id: job.branchResultMessageId, role: 'assistant', content,
      timestamp: job.updatedAt, state: job.state === 'completed' ? 'complete' : 'invalid',
      metadata: { remoteJobId: job.jobId, remoteStatus: job.remoteStatus } });
    if (!await this.storage.getConversation(job.parentConversationId)) throw new Error('Parent conversation no longer exists.');
    await this.ensureMessage(job.parentConversationId, { id: job.parentResultMessageId, role: 'assistant',
      content: `[Remote agent "${job.targetName}" ${job.state}]\n\n${content}`,
      timestamp: job.updatedAt, state: 'complete', metadata: { type: 'subagent_result', isAutoGenerated: true,
        remoteJobId: job.jobId, remoteTargetId: job.targetId, runId: job.runId, branchId: job.branchId,
        subagentId: job.jobId, success: job.state === 'completed', remoteStatus: job.remoteStatus } });
  }
}
