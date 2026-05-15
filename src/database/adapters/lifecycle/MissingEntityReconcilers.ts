/**
 * Registry of "missing entity" reconcile descriptors.
 *
 * The adapter used to carry three near-identical methods
 * (reconcileMissingWorkspaces/Conversations/Tasks) that differed only in
 * the category descriptor passed to ReconciliationCoordinator. Those
 * descriptors are built once here and the adapter just iterates them.
 */

import { SQLiteCacheManager } from '../../storage/SQLiteCacheManager';
import { ReconciliationCoordinator, ReconcileCategory } from './ReconciliationCoordinator';
import { WorkspaceEvent, ConversationEvent, TaskEvent } from '../../interfaces/StorageEvents';
import { WorkspaceEventApplier } from '../../sync/WorkspaceEventApplier';
import { ConversationEventApplier } from '../../sync/ConversationEventApplier';
import { TaskEventApplier } from '../../sync/TaskEventApplier';
import { resolveWorkspaceId } from '../../sync/resolveWorkspaceId';
import type { WorkspaceRepository } from '../../repositories/WorkspaceRepository';
import type { ConversationRepository } from '../../repositories/ConversationRepository';

export interface MissingEntityReconcilersDeps {
  sqliteCache: SQLiteCacheManager;
  workspaceRepo: WorkspaceRepository;
  conversationRepo: ConversationRepository;
}

export function buildWorkspaceReconcileCategory(
  deps: MissingEntityReconcilersDeps
): ReconcileCategory<WorkspaceEvent> {
  const applier = new WorkspaceEventApplier(deps.sqliteCache);
  return {
    label: 'workspace',
    subdir: 'workspaces',
    filenameRegex: /workspaces\/ws_(.+)\.jsonl$/,
    existsInCache: async (id) => (await deps.workspaceRepo.getById(id)) !== null,
    shouldSkipEvents: (events) => {
      if (events.some(e => e.type === 'workspace_deleted')) return true;
      return !events.some(e => e.type === 'workspace_created');
    },
    applyEvent: (e) => applier.apply(e)
  };
}

export function buildConversationReconcileCategory(
  deps: MissingEntityReconcilersDeps
): ReconcileCategory<ConversationEvent> {
  const applier = new ConversationEventApplier(deps.sqliteCache);
  return {
    label: 'conversation',
    subdir: 'conversations',
    filenameRegex: /conversations\/conv_(.+)\.jsonl$/,
    existsInCache: async (id) => (await deps.conversationRepo.getById(id)) !== null,
    shouldSkipEvents: (events) => {
      if (events.some(e => e.type === 'conversation_deleted')) return true;
      return !events.some(e => e.type === 'metadata');
    },
    applyEvent: (e) => applier.apply(e)
  };
}

export function buildTaskReconcileCategory(
  deps: MissingEntityReconcilersDeps
): ReconcileCategory<TaskEvent> {
  const applier = new TaskEventApplier(deps.sqliteCache);
  return {
    label: 'tasks',
    subdir: 'tasks',
    filenameRegex: /tasks\/tasks_(.+)\.jsonl$/,
    // Tasks resolve workspace name → UUID and probe `projects` directly:
    // they're keyed by workspaceId, not entity id.
    existsInCache: async (fileWorkspaceId) => {
      const resolved = await resolveWorkspaceId(fileWorkspaceId, deps.sqliteCache);
      const effectiveId = resolved.id ?? fileWorkspaceId;
      const projects = await deps.sqliteCache.query<{ id: string }>(
        'SELECT id FROM projects WHERE workspaceId = ? LIMIT 1',
        [effectiveId]
      );
      return projects.length > 0;
    },
    shouldSkipEvents: () => false,
    applyEvent: (e) => applier.apply(e)
  };
}

export class MissingEntityReconcilerRunner {
  constructor(
    private readonly coordinatorGetter: () => ReconciliationCoordinator,
    private readonly deps: MissingEntityReconcilersDeps
  ) {}

  workspaces(): Promise<number> {
    return this.coordinatorGetter().reconcile(buildWorkspaceReconcileCategory(this.deps));
  }

  conversations(): Promise<number> {
    return this.coordinatorGetter().reconcile(buildConversationReconcileCategory(this.deps));
  }

  tasks(): Promise<number> {
    return this.coordinatorGetter().reconcile(buildTaskReconcileCategory(this.deps));
  }

  /** Run all three reconcilers in parallel, swallow per-category errors. */
  async runAll(): Promise<void> {
    try {
      await Promise.all([this.workspaces(), this.conversations(), this.tasks()]);
    } catch (e) {
      console.error('[HybridStorageAdapter] Post-sync reconciliation failed:', e);
    }
  }

  /** Sequential variant with per-category labeled error logging. */
  async runAllSequential(): Promise<void> {
    await this.runOne('workspace', () => this.workspaces());
    await this.runOne('conversation', () => this.conversations());
    await this.runOne('task', () => this.tasks());
  }

  private async runOne(label: string, fn: () => Promise<number>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.error(`[HybridStorageAdapter] ${label} reconciliation failed:`, e);
    }
  }
}
