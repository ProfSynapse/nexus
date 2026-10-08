import { generateUUID } from '../../utils/uuid';
import type { AgentStatusItem, SubagentParams } from '../../types/branch/BranchTypes';
import { RemoteAgentJobRepository, remoteJobBranchState, type RemoteAgentJob } from '../../database/repositories/RemoteAgentJobRepository';
import { RemoteAgentError, type RemoteAgentConnection, type RemoteAgentRun } from './types';
import type { RemoteAgentConnectionRegistry } from './RemoteAgentConnectionRegistry';

const POLL_MS = 15_000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export interface RemoteAgentJobServiceDependencies {
  repository: RemoteAgentJobRepository;
  registry: RemoteAgentConnectionRegistry;
  vaultName: string;
  onDelivered?: (job: RemoteAgentJob) => Promise<void>;
  onError?: (error: unknown) => void;
  now?: () => number;
}

/** Public endpoint identity only; API keys never enter synced job metadata. */
export function remoteEndpointFingerprint(connection: RemoteAgentConnection): string {
  const url = new URL(connection.baseUrl.trim());
  if (url.username || url.password || url.search || url.hash) throw new Error('Remote endpoint URL must not contain credentials, query or fragment.');
  return `${connection.connector}:${url.href.replace(/\/+$/, '')}`;
}

export async function remoteCredentialFingerprint(connection: RemoteAgentConnection): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(connection.apiKey?.trim() ?? ''));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Plugin-owned runner: UI subscriptions have no influence on job lifetime. */
export class RemoteAgentJobService {
  private readonly jobs = new Map<string, RemoteAgentJob>();
  private readonly listeners = new Set<(job?: RemoteAgentJob) => void>();
  private readonly mutations = new Set<Promise<unknown>>();
  private lifecycleAbort = new AbortController();
  private timer: number | null = null;
  private tick: Promise<void> | null = null;
  private tickAbort: AbortController | null = null;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly deps: RemoteAgentJobServiceDependencies) {
    this.now = deps.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    if (this.lifecycleAbort.signal.aborted) this.lifecycleAbort = new AbortController();
    this.timer = window.setInterval(() => {
      void this.reconcile().catch(error => this.deps.onError?.(error));
    }, POLL_MS);
    // A cold-storage failure must not prevent the next interval retry.
    await this.reconcile();
  }

  async cleanup(): Promise<void> {
    this.stopped = true;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    this.lifecycleAbort.abort();
    this.tickAbort?.abort();
    await Promise.allSettled([...this.mutations, ...(this.tick ? [this.tick] : [])]);
    this.listeners.clear();
    // Closing Nexus never means cancel the remote task.
  }

  onChange(listener: (job?: RemoteAgentJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(job?: RemoteAgentJob): void {
    if (job) this.jobs.set(job.jobId, job);
    for (const listener of this.listeners) {
      try { listener(job); } catch (error) { this.deps.onError?.(error); }
    }
  }

  getActiveSubagents(): AgentStatusItem[] {
    return [...this.jobs.values()].map(job => ({
      subagentId: job.jobId, branchId: job.branchId, conversationId: job.parentConversationId,
      parentMessageId: job.originatingMessageId, task: job.task, state: remoteJobBranchState(job),
      iterations: 0, maxIterations: 1, startedAt: job.createdAt,
      remoteTargetId: job.targetId, remoteStatus: job.remoteStatus,
      remoteError: job.error,
      completedAt: TERMINAL.has(job.state) ? job.updatedAt : undefined,
    }));
  }

  getAgentStatusList(): AgentStatusItem[] { return this.getActiveSubagents(); }

  private mutation<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Remote job service is stopped.'));
    const pending = work().finally(() => this.mutations.delete(pending));
    this.mutations.add(pending);
    return pending;
  }

  executeSubagent(params: SubagentParams & { target: string }): Promise<{ subagentId: string; branchId: string }> {
    return this.mutation(() => this.submit(params));
  }

  private async submit(params: SubagentParams & { target: string }): Promise<{ subagentId: string; branchId: string }> {
    await this.deps.registry.refresh(params.target);
    if (this.stopped) throw new Error('Remote job service stopped before submission.');
    const connection = this.deps.registry.get(params.target);
    const health = this.deps.registry.getHealth(params.target);
    if (!connection?.enabled || !health?.connected || !health.runsAvailable || !health.durableIdempotency || !health.idempotencyRetentionMs) {
      throw new Error('Remote agent is unavailable or does not support durable idempotent runs. Check its connection.');
    }
    if (!params.task.trim()) throw new Error('Remote task must not be empty.');
    const jobId = `remote_${generateUUID()}`;
    const timestamp = this.now();
    const credentialFingerprint = await remoteCredentialFingerprint(connection);
    if (this.stopped) throw new Error('Remote job service stopped before submission.');
    const job = await this.deps.repository.create({
      schemaVersion: 1, jobId, targetId: params.target, targetName: connection.displayName,
      endpointFingerprint: remoteEndpointFingerprint(connection),
      credentialFingerprint,
      task: params.task, parentConversationId: params.parentConversationId, originatingMessageId: params.parentMessageId,
      parentOptions: { provider: params.provider, model: params.model, workspaceId: params.workspaceId,
        sessionId: params.sessionId, agentPrompt: params.agentPrompt, thinkingEnabled: params.thinkingEnabled,
        thinkingEffort: params.thinkingEffort },
      request: { input: params.context ? `${params.task}\n\nContext:\n${params.context}` : params.task },
      idempotencyKey: jobId, state: 'pending_submission', remoteStatus: 'pending_submission',
      createdAt: timestamp, updatedAt: timestamp, idempotencyRetentionMs: health.idempotencyRetentionMs,
      branchResultMessageId: `${jobId}-result`, parentResultMessageId: `${jobId}-parent-result`,
    }, this.deps.vaultName, this.lifecycleAbort.signal);
    this.changed(job);
    if (!this.stopped) void this.reconcile().catch(error => this.deps.onError?.(error));
    return { subagentId: jobId, branchId: job.branchId };
  }

  cancelSubagent(id: string): Promise<boolean> {
    return this.mutation(() => this.cancel(id));
  }

  private async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id) ?? (await this.deps.repository.list()).find(candidate => candidate.jobId === id);
    if (this.stopped) return false;
    if (!job) return false;
    const current = await this.deps.repository.get(job.branchId);
    if (this.stopped) return false;
    if (!current) {
      this.jobs.delete(id);
      this.changed();
      return false;
    }
    if (TERMINAL.has(current.state)) {
      this.changed(current);
      return false;
    }
    const updated = await this.deps.repository.update(job.branchId, {
      cancelRequestedAt: this.now(), updatedAt: this.now(), nextPollAt: undefined,
    });
    this.changed(updated);
    void this.reconcile().catch(error => this.deps.onError?.(error));
    return true;
  }

  reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.tick) return this.tick;
    const controller = new AbortController();
    this.tickAbort = controller;
    const pending = this.runTick(controller.signal).finally(() => {
      if (this.tick === pending) this.tick = null;
      if (this.tickAbort === controller) this.tickAbort = null;
    });
    this.tick = pending;
    return pending;
  }

  private async runTick(signal: AbortSignal): Promise<void> {
    const previouslyKnown = new Set(this.jobs.keys());
    const recovered = await this.deps.repository.list();
    const recoveredIds = new Set(recovered.map(job => job.jobId));
    for (const id of previouslyKnown) {
      if (!recoveredIds.has(id)) this.jobs.delete(id);
    }
    // Jobs accepted while the async scan was underway were not in its snapshot.
    // Keep them until a subsequent scan can include their durable branch.
    for (const job of recovered) this.jobs.set(job.jobId, job);
    this.changed();
    for (const job of recovered) {
      if (signal.aborted || this.stopped) return;
      if (job.nextPollAt && job.nextPollAt > this.now()) continue;
      try { await this.process(job, signal); }
      catch (error) {
        if (signal.aborted || this.stopped) return;
        // Storage/delivery failure leaves durable state in place for the next tick.
        this.deps.onError?.(error);
      }
    }
  }

  private async write(job: RemoteAgentJob, patch: Partial<RemoteAgentJob>): Promise<RemoteAgentJob> {
    if (patch.state === 'attention') patch = { ...patch, remoteStatus: 'needs_attention' };
    const updated = await this.deps.repository.update(job.branchId, { ...patch, updatedAt: this.now() });
    if (updated.state === 'attention') await this.deps.repository.ensureAttentionMessage(updated);
    this.changed(updated);
    return updated;
  }

  private async process(job: RemoteAgentJob, signal: AbortSignal): Promise<void> {
    if (TERMINAL.has(job.state)) {
      if (job.deliveredAt === undefined) {
        await this.deps.repository.deliver(job);
        job = await this.write(job, { deliveredAt: this.now(), nextPollAt: undefined });
      }
      if (this.deps.onDelivered && job.notifiedAt === undefined) {
        await this.deps.onDelivered(job);
        await this.write(job, { notifiedAt: this.now() });
      }
      return;
    }
    const connection = this.deps.registry.get(job.targetId);
    if (!connection || remoteEndpointFingerprint(connection) !== job.endpointFingerprint
      || await remoteCredentialFingerprint(connection) !== job.credentialFingerprint) {
      await this.write(job, { state: 'attention', error: 'Remote endpoint or credential scope was removed or changed. Restore the original connection or check the remote agent; this job will not be redirected.', nextPollAt: this.now() + 60_000 });
      return;
    }
    const connector = this.deps.registry.getConnector(connection);
    if (signal.aborted || this.stopped) return;
    await this.deps.repository.ensureTaskMessage(job);
    if (signal.aborted || this.stopped) return;
    try {
      if (!job.runId) {
        if (job.cancelRequestedAt !== undefined) {
          if (job.submissionStartedAt !== undefined) {
            await this.write(job, { state: 'attention', error: 'Cancellation requested, but submission outcome is unknown. Check the remote agent; Nexus will not start a new run.', nextPollAt: this.now() + 60_000 });
          } else {
            await this.write(job, { state: 'cancelled', remoteStatus: 'cancelled_before_submission', error: 'Cancelled before submission.' });
          }
          return;
        }
        if (job.submissionStartedAt !== undefined && (!job.idempotencyRetentionMs
          || this.now() - job.submissionStartedAt >= job.idempotencyRetentionMs)) {
          await this.write(job, { state: 'attention', error: 'Submission outcome is unknown and its idempotency retention expired. Check the remote agent before creating another job.', nextPollAt: this.now() + 60_000 });
          return;
        }
        let health = this.deps.registry.getHealth(job.targetId);
        if (!health) {
          await this.deps.registry.refresh(job.targetId);
          if (signal.aborted || this.stopped) return;
          health = this.deps.registry.getHealth(job.targetId);
        }
        if (!health?.connected || !health.runsAvailable || !health.durableIdempotency || !health.idempotencyRetentionMs) {
          await this.write(job, { state: 'attention', error: 'Remote agent durable Runs capability is unavailable. Existing submission identity is retained.', nextPollAt: this.now() + 60_000 });
          return;
        }
        if (job.submissionStartedAt !== undefined
          && this.now() - job.submissionStartedAt >= health.idempotencyRetentionMs) {
          await this.write(job, { state: 'attention', error: 'Remote replay retention is no longer sufficient to retry this submission safely.', nextPollAt: this.now() + 60_000 });
          return;
        }
        if (signal.aborted || this.stopped) return;
        const previouslyAttempted = job.submissionStartedAt !== undefined;
        job = await this.write(job, { state: 'submitting', remoteStatus: 'submitting',
          submissionStartedAt: job.submissionStartedAt ?? this.now(), error: undefined });
        // The repository merges the latest record. Stop may have been persisted
        // while health/readiness was awaited, after the earlier snapshot check.
        if (job.cancelRequestedAt !== undefined) {
          await this.write(job, previouslyAttempted
            ? { state: 'attention', error: 'Cancellation requested, but submission outcome is unknown. Check the remote agent; Nexus will not start a new run.', nextPollAt: this.now() + 60_000 }
            : { state: 'cancelled', remoteStatus: 'cancelled_before_submission', submissionStartedAt: undefined, error: 'Cancelled before submission.' });
          return;
        }
        if (signal.aborted || this.stopped) return;
        const run = await connector.submit(connection, job.request, job.idempotencyKey, signal);
        await this.acceptRun(job, run);
      } else {
        if (job.cancelRequestedAt !== undefined) {
          const run = await connector.cancel(connection, job.runId, signal);
          await this.acceptRun(job, run);
        } else {
          const run = await connector.get(connection, job.runId, signal);
          await this.acceptRun(job, run);
        }
      }
    } catch (error) {
      if (signal.aborted || this.stopped) return;
      const failureCount = Math.min((job.failureCount ?? 0) + 1, 6);
      const nextPollAt = this.now() + Math.min(POLL_MS * 2 ** (failureCount - 1), 60_000);
      if (error instanceof RemoteAgentError) {
        const explicitSubmitRejection = !job.runId && !error.submissionOutcomeUnknown;
        const unrecoverable = error.code === 'RUN_NOT_FOUND' || error.code === 'IDEMPOTENCY_CONFLICT'
          || ['INVALID_CONFIG', 'UNSUPPORTED', 'PROTOCOL'].includes(error.code)
          || error.status === 401 || error.status === 403;
        await this.write(job, {
          state: explicitSubmitRejection ? 'failed' : unrecoverable ? 'attention' : job.runId ? 'running' : 'submitting',
          remoteStatus: error.code, error: error.message, failureCount, nextPollAt,
        });
      } else {
        // Unknown errors after a POST must never authorize a new request identity.
        await this.write(job, { state: job.runId ? 'running' : 'submitting', remoteStatus: 'transport_error',
          error: 'Remote request failed; its result will be reconciled without creating another task.', failureCount, nextPollAt });
      }
    }
  }

  private async acceptRun(job: RemoteAgentJob, run: RemoteAgentRun): Promise<void> {
    const state = String(run.state);
    const terminal = TERMINAL.has(state);
    await this.write(job, { runId: run.runId, remoteSessionId: run.sessionId, remoteStatus: run.remoteStatus,
      state: terminal ? state as 'completed' | 'failed' | 'cancelled' : state === 'needs_attention' || state === 'unknown' ? 'attention' : 'running',
      output: run.output, error: run.error, failureCount: 0,
      nextPollAt: terminal ? undefined : this.now() + POLL_MS });
  }
}
