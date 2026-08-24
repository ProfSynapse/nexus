import type {
  ToolOperationCompletedEvent,
  ToolOperationFailedEvent,
  ToolOperationIndeterminateEvent,
  ToolOperationStartedEvent,
  WorkspaceEvent,
} from '../interfaces/StorageEvents';
import type {
  ToolOperationReceipt,
  ToolOperationStatus,
  ToolExecutionOrigin,
} from '../../types/tools/ToolOperationTypes';
import type { ToolReplayPolicy } from '../../agents/policy/ToolExecutionPolicy';
import { WorkspaceEventApplier } from '../sync/WorkspaceEventApplier';
import type { RepositoryDependencies } from './base/BaseRepository';
import type {
  CompleteToolOperationData,
  FinishToolOperationData,
  IToolOperationRepository,
} from './interfaces/IToolOperationRepository';
import type { StartToolOperationData } from '../../types/tools/ToolOperationTypes';

interface ToolOperationRow {
  operationId: string;
  signature: string;
  status: ToolOperationStatus;
  origin: ToolExecutionOrigin;
  workspaceId: string;
  sessionId: string;
  conversationId?: string | null;
  messageId?: string | null;
  turnId?: string | null;
  replayPolicy: ToolReplayPolicy;
  replayable: number;
  commandSummary: string;
  resultJson?: string | null;
  resultTruncated: number;
  error?: string | null;
  startedAt: number;
  completedAt?: number | null;
  updatedAt: number;
}

/** JSONL-first repository for durable tool operation receipts. */
export class ToolOperationRepository implements IToolOperationRepository {
  private readonly applier: WorkspaceEventApplier;
  private readonly eventIndexes = new Map<string, {
    modTime: number | null;
    byOperationId: Map<string, WorkspaceEvent[]>;
  }>();
  private readonly indexLoads = new Map<string, Promise<Map<string, WorkspaceEvent[]>>>();

  constructor(private readonly deps: RepositoryDependencies) {
    this.applier = new WorkspaceEventApplier(deps.sqliteCache);
  }

  async getById(operationId: string, workspaceId: string): Promise<ToolOperationReceipt | null> {
    let row = await this.deps.sqliteCache.queryOne<ToolOperationRow>(
      'SELECT * FROM tool_operation_receipts WHERE operationId = ?',
      [operationId]
    );

    // JSONL is authoritative. A plugin reload can begin before the old
    // instance's async SQLite close/save finishes, leaving the newly loaded
    // cache behind the event stream. Repair a missing or non-terminal
    // projection on demand so retry safety never depends on cache timing.
    if (!row || row.status === 'started') {
      const matching = [...(await this.getEventIndex(workspaceId)).get(operationId) ?? []]
        .sort((a, b) => {
          if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
          if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
      for (const event of matching) {
        await this.applier.apply(event);
      }
      if (matching.length > 0) {
        this.deps.queryCache.clear();
        row = await this.deps.sqliteCache.queryOne<ToolOperationRow>(
          'SELECT * FROM tool_operation_receipts WHERE operationId = ?',
          [operationId]
        );
      }
    }
    return row ? this.rowToReceipt(row) : null;
  }

  async start(data: StartToolOperationData): Promise<boolean> {
    const event = await this.deps.jsonlWriter.appendEvent<ToolOperationStartedEvent>(
      this.path(data.workspaceId),
      { type: 'tool_operation_started', workspaceId: data.workspaceId, data }
    );
    await this.addToEventIndex(data.workspaceId, event);
    return await this.apply(event) === true;
  }

  async complete(data: CompleteToolOperationData): Promise<void> {
    const completedAt = data.completedAt ?? Date.now();
    const event = await this.deps.jsonlWriter.appendEvent<ToolOperationCompletedEvent>(
      this.path(data.workspaceId),
      { type: 'tool_operation_completed', ...data, completedAt }
    );
    await this.addToEventIndex(data.workspaceId, event);
    await this.apply(event);
  }

  async fail(data: FinishToolOperationData): Promise<void> {
    const completedAt = data.completedAt ?? Date.now();
    const event = await this.deps.jsonlWriter.appendEvent<ToolOperationFailedEvent>(
      this.path(data.workspaceId),
      { type: 'tool_operation_failed', ...data, completedAt }
    );
    await this.addToEventIndex(data.workspaceId, event);
    await this.apply(event);
  }

  async markIndeterminate(data: FinishToolOperationData): Promise<void> {
    const completedAt = data.completedAt ?? Date.now();
    const event = await this.deps.jsonlWriter.appendEvent<ToolOperationIndeterminateEvent>(
      this.path(data.workspaceId),
      { type: 'tool_operation_indeterminate', ...data, completedAt }
    );
    await this.addToEventIndex(data.workspaceId, event);
    await this.apply(event);
  }

  private path(workspaceId: string): string {
    return `workspaces/ws_${workspaceId}.jsonl`;
  }

  private operationIdOf(event: WorkspaceEvent): string | undefined {
    if (event.type === 'tool_operation_started') return event.data.operationId;
    if (
      event.type === 'tool_operation_completed'
      || event.type === 'tool_operation_failed'
      || event.type === 'tool_operation_indeterminate'
    ) {
      return event.operationId;
    }
    return undefined;
  }

  private async apply(event: WorkspaceEvent): Promise<boolean | void> {
    const applied = await this.applier.apply(event);
    this.deps.queryCache.clear();
    return applied;
  }

  private async getEventIndex(workspaceId: string): Promise<Map<string, WorkspaceEvent[]>> {
    const path = this.path(workspaceId);
    const modTime = await this.deps.jsonlWriter.getFileModTime(path);
    const cached = this.eventIndexes.get(workspaceId);
    if (cached && cached.modTime === modTime) return cached.byOperationId;

    const activeLoad = this.indexLoads.get(workspaceId);
    if (activeLoad) return activeLoad;

    const load = this.deps.jsonlWriter.readEvents<WorkspaceEvent>(path).then(events => {
      const byOperationId = new Map<string, WorkspaceEvent[]>();
      for (const event of events) {
        const operationId = this.operationIdOf(event);
        if (!operationId) continue;
        const matching = byOperationId.get(operationId) ?? [];
        matching.push(event);
        byOperationId.set(operationId, matching);
      }
      this.eventIndexes.set(workspaceId, { modTime, byOperationId });
      return byOperationId;
    }).finally(() => {
      this.indexLoads.delete(workspaceId);
    });
    this.indexLoads.set(workspaceId, load);
    return load;
  }

  private async addToEventIndex(workspaceId: string, event: WorkspaceEvent): Promise<void> {
    const cached = this.eventIndexes.get(workspaceId);
    if (!cached) return;
    const operationId = this.operationIdOf(event);
    if (!operationId) return;
    const matching = cached.byOperationId.get(operationId) ?? [];
    matching.push(event);
    cached.byOperationId.set(operationId, matching);
    const modTime = await this.deps.jsonlWriter.getFileModTime(this.path(workspaceId));
    const current = this.eventIndexes.get(workspaceId);
    if (current === cached) current.modTime = modTime;
  }

  private rowToReceipt(row: ToolOperationRow): ToolOperationReceipt {
    return {
      operationId: row.operationId,
      signature: row.signature,
      status: row.status,
      origin: row.origin,
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      conversationId: row.conversationId ?? undefined,
      messageId: row.messageId ?? undefined,
      turnId: row.turnId ?? undefined,
      replayPolicy: row.replayPolicy,
      replayable: row.replayable === 1,
      commandSummary: row.commandSummary,
      resultJson: row.resultJson ?? undefined,
      resultTruncated: row.resultTruncated === 1,
      error: row.error ?? undefined,
      startedAt: row.startedAt,
      completedAt: row.completedAt ?? undefined,
      updatedAt: row.updatedAt,
    };
  }
}
