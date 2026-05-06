/**
 * Location: src/database/sync/SyncCoordinator.ts
 *
 * Synchronization coordinator between JSONL (source of truth) and SQLite (cache).
 *
 * Thin orchestrator that delegates event application to:
 * - WorkspaceEventApplier: workspace, session, state, trace events
 * - ConversationEventApplier: conversation, message events
 * - TaskEventApplier: project, task, dependency, note-link events
 *
 * Design Principles:
 * - Single Responsibility: Orchestration only
 * - Open/Closed: Add new event types via new appliers
 * - Dependency Injection: All dependencies passed to constructor
 */

import { BatchOperations } from '../optimizations/BatchOperations';
import {
  StorageEvent,
  WorkspaceEvent,
  ConversationEvent,
  TaskEvent,
} from '../interfaces/StorageEvents';
import { WorkspaceEventApplier } from './WorkspaceEventApplier';
import { ConversationEventApplier } from './ConversationEventApplier';
import { TaskEventApplier } from './TaskEventApplier';
import type { ReconcilePipeline } from './ReconcilePipeline';
import type { EventStreamCategory } from '../storage/vaultRoot/EventStreamUtilities';

/**
 * Validate workspace ID to prevent ghost/orphan workspaces.
 * Rejects "undefined", "null", and empty/whitespace-only IDs.
 */
function isValidWorkspaceId(id: string): boolean {
  return !!id && id !== 'undefined' && id !== 'null' && id.trim().length > 0;
}

// ============================================================================
// Interfaces
// ============================================================================

export interface IJSONLWriter {
  getDeviceId(): string;
  listFiles(category: 'workspaces' | 'conversations' | 'tasks'): Promise<string[]>;
  getFileModTime(file: string): Promise<number | null>;
  readEvents<T extends StorageEvent>(file: string): Promise<T[]>;
  getEventsNotFromDevice<T extends StorageEvent>(
    file: string,
    deviceId: string,
    sinceTimestamp?: number
  ): Promise<T[]>;
}

export interface ISQLiteCacheManager {
  getSyncState(deviceId: string): Promise<SyncState | null>;
  updateSyncState(deviceId: string, lastEventTimestamp: number, fileTimestamps: Record<string, number>): Promise<void>;
  isEventApplied(eventId: string): Promise<boolean>;
  markEventApplied(eventId: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  clearAllData(): Promise<void>;
  rebuildFTSIndexes(): Promise<void>;
  save(): Promise<void>;
}

export interface SyncState {
  deviceId: string;
  lastEventTimestamp: number;
  fileTimestamps: Record<string, number>;
}

export interface SyncResult {
  success: boolean;
  eventsApplied: number;
  eventsSkipped: number;
  errors: string[];
  duration: number;
  filesProcessed: string[];
  lastSyncTimestamp: number;
}

export interface SyncOptions {
  forceRebuild?: boolean;
  onProgress?: (phase: string, progress: number, total: number) => void;
  batchSize?: number;
}

// ============================================================================
// SyncCoordinator
// ============================================================================

export class SyncCoordinator {
  private jsonlWriter: IJSONLWriter;
  private sqliteCache: ISQLiteCacheManager;
  private deviceId: string;
  private workspaceApplier: WorkspaceEventApplier;
  private conversationApplier: ConversationEventApplier;
  private taskApplier: TaskEventApplier;

  /**
   * Optional sync-safe reconcile pipeline. When wired (via
   * `setReconcilePipeline`), `sync()` delegates to it so cursor-based
   * idempotency (Phase 1 of `docs/plans/sync-safe-storage-reconcile-plan.md`)
   * replaces the per-file mod-time scan. Left null until HybridStorageAdapter
   * constructs the pipeline; `fullRebuild()` keeps its existing applier loops
   * regardless because cold-boot rebuild semantics are out of Phase 1 scope.
   */
  private reconcilePipeline: ReconcilePipeline | null = null;

  /** Guards against overlapping sync() calls. */
  private syncing = false;
  /** Set when a sync() call arrives while another is in-flight. */
  private syncQueued = false;

  constructor(jsonlWriter: IJSONLWriter, sqliteCache: ISQLiteCacheManager) {
    this.jsonlWriter = jsonlWriter;
    this.sqliteCache = sqliteCache;
    this.deviceId = jsonlWriter.getDeviceId();
    this.workspaceApplier = new WorkspaceEventApplier(sqliteCache);
    this.conversationApplier = new ConversationEventApplier(sqliteCache);
    this.taskApplier = new TaskEventApplier(sqliteCache);
  }

  /** Inject the ReconcilePipeline. Idempotent; pass `null` to detach. */
  setReconcilePipeline(pipeline: ReconcilePipeline | null): void {
    this.reconcilePipeline = pipeline;
  }

  /** Expose the sibling appliers so `ReconcilePipeline` can reuse them. */
  getAppliers(): {
    workspace: WorkspaceEventApplier;
    conversation: ConversationEventApplier;
    task: TaskEventApplier;
  } {
    return {
      workspace: this.workspaceApplier,
      conversation: this.conversationApplier,
      task: this.taskApplier
    };
  }

  /**
   * Scoped reconcile for a single shard, invoked by the vault watcher when
   * a remote-sync drop lands a new shard on disk. No-ops if the
   * ReconcilePipeline isn't wired.
   */
  async reconcileShard(shardPath: string): Promise<void> {
    if (!this.reconcilePipeline) return;
    await this.reconcilePipeline.reconcileShard(shardPath);
  }

  /** Same shape as reconcileShard, scoped to a single logical stream. */
  async reconcileStream(category: EventStreamCategory, streamId: string): Promise<void> {
    if (!this.reconcilePipeline) return;
    await this.reconcilePipeline.reconcileStream(category, streamId);
  }

  /**
   * Synchronize JSONL files to SQLite cache.
   *
   * Guarded by an async mutex: if a sync is already running, the call is
   * queued and the in-flight run will re-check for pending changes when it
   * finishes. This prevents two overlapping runs from applying the same
   * events twice or writing stale timestamps.
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    if (this.syncing) {
      this.syncQueued = true;
      return this.createResult(true, 0, 0, [], Date.now(), []);
    }

    this.syncing = true;
    try {
      return await this.syncInner(options);
    } finally {
      this.syncing = false;
      if (this.syncQueued) {
        this.syncQueued = false;
        // Re-run to pick up changes that landed during the previous sync.
        // Don't await — callers of the queued sync already got their
        // early-return result above.
        void this.sync(options);
      }
    }
  }

  private async syncInner(options: SyncOptions = {}): Promise<SyncResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let eventsApplied = 0;
    let eventsSkipped = 0;
    const filesProcessed: string[] = [];
    const nextFileTimestamps: Record<string, number> = {};

    try {
      if (options.forceRebuild) {
        return this.fullRebuild(options);
      }

      // When ReconcilePipeline is wired (Phase 1 sync-safe reconcile), the
      // cursor-based path replaces the per-file mod-time scan. Cold-boot
      // recovery still goes through `fullRebuild` above.
      if (this.reconcilePipeline) {
        const reconcile = await this.reconcilePipeline.reconcileAll();
        await this.sqliteCache.updateSyncState(this.deviceId, Date.now(), {});
        await this.sqliteCache.save();
        options.onProgress?.('Complete', 1, 1);
        return this.createResult(
          reconcile.success,
          reconcile.eventsApplied,
          reconcile.eventsSkipped,
          reconcile.errors,
          startTime,
          []
        );
      }

      const syncState = await this.sqliteCache.getSyncState(this.deviceId);
      const previousFileTimestamps = syncState?.fileTimestamps ?? {};

      // Process workspace files
      const workspaceResult = await this.processWorkspaceFiles(previousFileTimestamps, options, errors);
      eventsApplied += workspaceResult.applied;
      eventsSkipped += workspaceResult.skipped;
      filesProcessed.push(...workspaceResult.files);
      Object.assign(nextFileTimestamps, workspaceResult.fileTimestamps);

      // Process conversation files
      const conversationResult = await this.processConversationFiles(previousFileTimestamps, options, errors);
      eventsApplied += conversationResult.applied;
      eventsSkipped += conversationResult.skipped;
      filesProcessed.push(...conversationResult.files);
      Object.assign(nextFileTimestamps, conversationResult.fileTimestamps);

      // Process task files
      const taskResult = await this.processTaskFiles(previousFileTimestamps, options, errors);
      eventsApplied += taskResult.applied;
      eventsSkipped += taskResult.skipped;
      filesProcessed.push(...taskResult.files);
      Object.assign(nextFileTimestamps, taskResult.fileTimestamps);

      // Update sync state and save
      await this.sqliteCache.updateSyncState(this.deviceId, Date.now(), nextFileTimestamps);
      await this.sqliteCache.save();

      options.onProgress?.('Complete', 1, 1);

      return this.createResult(errors.length === 0, eventsApplied, eventsSkipped, errors, startTime, filesProcessed);
    } catch (error) {
      return this.createResult(false, eventsApplied, eventsSkipped, [...errors, `Sync failed: ${String(error)}`], startTime, filesProcessed);
    }
  }

  /**
   * Full rebuild of SQLite from JSONL files.
   *
   * NOTE: Uses smaller batch size (25) to avoid OOM errors with sql.js asm.js version.
   * Saves after each file to prevent memory accumulation.
   */
  async fullRebuild(options: SyncOptions = {}): Promise<SyncResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let eventsApplied = 0;
    const filesProcessed: string[] = [];
    // Use smaller batch size for full rebuild to avoid OOM
    const batchSize = options.batchSize ?? 25;

    try {
      options.onProgress?.('Clearing cache', 0, 1);
      await this.sqliteCache.clearAllData();

      // Rebuild workspaces
      const workspaceResult = await this.rebuildWorkspaces(options, errors, batchSize);
      eventsApplied += workspaceResult.applied;
      filesProcessed.push(...workspaceResult.files);

      // Rebuild conversations
      const conversationResult = await this.rebuildConversations(options, errors, batchSize);
      eventsApplied += conversationResult.applied;
      filesProcessed.push(...conversationResult.files);

      // Rebuild tasks (must come after workspaces for normalizeWorkspaceId to work)
      const taskResult = await this.rebuildTasks(options, errors, batchSize);
      eventsApplied += taskResult.applied;
      filesProcessed.push(...taskResult.files);

      // Rebuild FTS and save
      options.onProgress?.('Rebuilding search indexes', 0, 1);
      await this.sqliteCache.rebuildFTSIndexes();
      await this.sqliteCache.updateSyncState(this.deviceId, Date.now(), {});
      await this.sqliteCache.save();

      options.onProgress?.('Complete', 1, 1);

      return this.createResult(errors.length === 0, eventsApplied, 0, errors, startTime, filesProcessed);
    } catch (error) {
      console.error('[SyncCoordinator] Full rebuild failed:', error);
      // Still save sync state so we don't rebuild again on next restart
      try {
        await this.sqliteCache.updateSyncState(this.deviceId, Date.now(), {});
        await this.sqliteCache.save();
      } catch (saveError) {
        console.error('[SyncCoordinator] Failed to save sync state:', saveError);
      }
      return this.createResult(false, eventsApplied, 0, [...errors, `Rebuild failed: ${String(error)}`], startTime, filesProcessed);
    }
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private async processWorkspaceFiles(
    previousFileTimestamps: Record<string, number>,
    options: SyncOptions,
    errors: string[]
  ): Promise<{ applied: number; skipped: number; files: string[]; fileTimestamps: Record<string, number> }> {
    let applied = 0;
    let skipped = 0;
    const files: string[] = [];
    const fileTimestamps: Record<string, number> = {};

    const workspaceFiles = await this.jsonlWriter.listFiles('workspaces');
    options.onProgress?.('Processing workspaces', 0, workspaceFiles.length);

    for (let i = 0; i < workspaceFiles.length; i++) {
      const file = workspaceFiles[i];

      // Skip files with invalid workspace IDs extracted from filename
      const wsIdMatch = file.match(/ws_(.+)\.jsonl$/);
      if (wsIdMatch && !isValidWorkspaceId(wsIdMatch[1])) {
        continue;
      }

      try {
        const modTime = await this.jsonlWriter.getFileModTime(file);
        if (typeof modTime === 'number' && Number.isFinite(modTime)) {
          fileTimestamps[file] = modTime;
          if ((previousFileTimestamps[file] ?? 0) >= modTime) {
            files.push(file);
            options.onProgress?.('Processing workspaces', i + 1, workspaceFiles.length);
            continue;
          }
        }

        const events = await this.jsonlWriter.getEventsNotFromDevice<WorkspaceEvent>(
          file, this.deviceId
        );

        for (const event of events) {
          if (await this.sqliteCache.isEventApplied(event.id)) {
            skipped++;
            continue;
          }
          await this.workspaceApplier.apply(event);
          await this.sqliteCache.markEventApplied(event.id);
          applied++;
        }

        files.push(file);
        options.onProgress?.('Processing workspaces', i + 1, workspaceFiles.length);
      } catch (e) {
        errors.push(`Failed to process ${file}: ${String(e)}`);
      }
    }

    return { applied, skipped, files, fileTimestamps };
  }

  private async processConversationFiles(
    previousFileTimestamps: Record<string, number>,
    options: SyncOptions,
    errors: string[]
  ): Promise<{ applied: number; skipped: number; files: string[]; fileTimestamps: Record<string, number> }> {
    let applied = 0;
    let skipped = 0;
    const files: string[] = [];
    const fileTimestamps: Record<string, number> = {};

    const conversationFiles = await this.jsonlWriter.listFiles('conversations');
    options.onProgress?.('Processing conversations', 0, conversationFiles.length);

    for (let i = 0; i < conversationFiles.length; i++) {
      const file = conversationFiles[i];
      try {
        const modTime = await this.jsonlWriter.getFileModTime(file);
        if (typeof modTime === 'number' && Number.isFinite(modTime)) {
          fileTimestamps[file] = modTime;
          if ((previousFileTimestamps[file] ?? 0) >= modTime) {
            files.push(file);
            options.onProgress?.('Processing conversations', i + 1, conversationFiles.length);
            continue;
          }
        }

        const events = await this.jsonlWriter.getEventsNotFromDevice<ConversationEvent>(
          file, this.deviceId
        );

        for (const event of events) {
          if (await this.sqliteCache.isEventApplied(event.id)) {
            skipped++;
            continue;
          }
          await this.conversationApplier.apply(event);
          await this.sqliteCache.markEventApplied(event.id);
          applied++;
        }

        files.push(file);
        options.onProgress?.('Processing conversations', i + 1, conversationFiles.length);
      } catch (e) {
        errors.push(`Failed to process ${file}: ${String(e)}`);
      }
    }

    return { applied, skipped, files, fileTimestamps };
  }

  private async rebuildWorkspaces(
    options: SyncOptions,
    errors: string[],
    batchSize: number
  ): Promise<{ applied: number; files: string[] }> {
    let applied = 0;
    const files: string[] = [];

    const workspaceFiles = await this.jsonlWriter.listFiles('workspaces');
    options.onProgress?.('Processing workspaces', 0, workspaceFiles.length);

    for (let i = 0; i < workspaceFiles.length; i++) {
      const file = workspaceFiles[i];

      // Skip files with invalid workspace IDs extracted from filename
      const rebuildWsIdMatch = file.match(/ws_(.+)\.jsonl$/);
      if (rebuildWsIdMatch && !isValidWorkspaceId(rebuildWsIdMatch[1])) {
        continue;
      }

      try {
        const events = await this.jsonlWriter.readEvents<WorkspaceEvent>(file);
        events.sort((a, b) => a.timestamp - b.timestamp);

        // Skip orphaned JSONLs that lack a workspace_created event (legacy files)
        const hasWorkspaceCreated = events.some(e => e.type === 'workspace_created');
        if (!hasWorkspaceCreated && events.length > 0) {
          continue;
        }

        // Process in very small batches with delays to avoid OOM
        const result = await BatchOperations.executeBatch(
          events,
          async (event) => {
            await this.workspaceApplier.apply(event);
            await this.sqliteCache.markEventApplied(event.id);
          },
          { batchSize: Math.min(batchSize, 10), delayBetweenBatches: 10 }
        );

        applied += result.totalProcessed;
        if (result.errors.length > 0) {
          errors.push(...result.errors.map(e => `${file}: ${e.error.message}`));
        }

        files.push(file);
        options.onProgress?.('Processing workspaces', i + 1, workspaceFiles.length);

        // Save after each file to prevent memory accumulation (OOM prevention)
        await this.sqliteCache.save();
      } catch (e) {
        errors.push(`Failed to process ${file}: ${String(e)}`);
      }
    }

    return { applied, files };
  }

  private async rebuildConversations(
    options: SyncOptions,
    errors: string[],
    batchSize: number
  ): Promise<{ applied: number; files: string[] }> {
    let applied = 0;
    const files: string[] = [];

    const conversationFiles = await this.jsonlWriter.listFiles('conversations');
    options.onProgress?.('Processing conversations', 0, conversationFiles.length);

    for (let i = 0; i < conversationFiles.length; i++) {
      const file = conversationFiles[i];
      try {
        const events = await this.jsonlWriter.readEvents<ConversationEvent>(file);
        events.sort((a, b) => a.timestamp - b.timestamp);

        const result = await BatchOperations.executeBatch(
          events,
          async (event) => {
            await this.conversationApplier.apply(event);
            await this.sqliteCache.markEventApplied(event.id);
          },
          { batchSize }
        );

        applied += result.totalProcessed;
        if (result.errors.length > 0) {
          errors.push(...result.errors.map(e => `${file}: ${e.error.message}`));
        }

        files.push(file);
        options.onProgress?.('Processing conversations', i + 1, conversationFiles.length);

        // Save after each file to prevent memory accumulation (OOM prevention)
        await this.sqliteCache.save();
      } catch (e) {
        errors.push(`Failed to process ${file}: ${String(e)}`);
      }
    }

    return { applied, files };
  }

  private async processTaskFiles(
    previousFileTimestamps: Record<string, number>,
    options: SyncOptions,
    errors: string[]
  ): Promise<{ applied: number; skipped: number; files: string[]; fileTimestamps: Record<string, number> }> {
    let applied = 0;
    let skipped = 0;
    const files: string[] = [];
    const fileTimestamps: Record<string, number> = {};

    const taskFiles = await this.jsonlWriter.listFiles('tasks');
    options.onProgress?.('Processing tasks', 0, taskFiles.length);

    for (let i = 0; i < taskFiles.length; i++) {
      const file = taskFiles[i];
      try {
        const modTime = await this.jsonlWriter.getFileModTime(file);
        if (typeof modTime === 'number' && Number.isFinite(modTime)) {
          fileTimestamps[file] = modTime;
          if ((previousFileTimestamps[file] ?? 0) >= modTime) {
            files.push(file);
            options.onProgress?.('Processing tasks', i + 1, taskFiles.length);
            continue;
          }
        }

        const events = await this.jsonlWriter.getEventsNotFromDevice<TaskEvent>(
          file, this.deviceId
        );

        for (const event of events) {
          if (await this.sqliteCache.isEventApplied(event.id)) {
            skipped++;
            continue;
          }
          await this.taskApplier.apply(event);
          await this.sqliteCache.markEventApplied(event.id);
          applied++;
        }

        files.push(file);
        options.onProgress?.('Processing tasks', i + 1, taskFiles.length);
      } catch (e) {
        errors.push(`Failed to process ${file}: ${String(e)}`);
      }
    }

    return { applied, skipped, files, fileTimestamps };
  }

  private async rebuildTasks(
    options: SyncOptions,
    errors: string[],
    batchSize: number
  ): Promise<{ applied: number; files: string[] }> {
    let applied = 0;
    const files: string[] = [];

    const taskFiles = await this.jsonlWriter.listFiles('tasks');
    options.onProgress?.('Processing tasks', 0, taskFiles.length);

    for (let i = 0; i < taskFiles.length; i++) {
      const file = taskFiles[i];
      try {
        const events = await this.jsonlWriter.readEvents<TaskEvent>(file);
        events.sort((a, b) => a.timestamp - b.timestamp);

        const result = await BatchOperations.executeBatch(
          events,
          async (event) => {
            await this.taskApplier.apply(event);
            await this.sqliteCache.markEventApplied(event.id);
          },
          { batchSize: Math.min(batchSize, 10), delayBetweenBatches: 10 }
        );

        applied += result.totalProcessed;
        if (result.errors.length > 0) {
          errors.push(...result.errors.map(e => `${file}: ${e.error.message}`));
        }

        files.push(file);
        options.onProgress?.('Processing tasks', i + 1, taskFiles.length);

        // Save after each file to prevent memory accumulation (OOM prevention)
        await this.sqliteCache.save();
      } catch (e) {
        errors.push(`Failed to process ${file}: ${String(e)}`);
      }
    }

    return { applied, files };
  }

  private createResult(
    success: boolean,
    eventsApplied: number,
    eventsSkipped: number,
    errors: string[],
    startTime: number,
    filesProcessed: string[]
  ): SyncResult {
    return {
      success,
      eventsApplied,
      eventsSkipped,
      errors,
      duration: Date.now() - startTime,
      filesProcessed,
      lastSyncTimestamp: Date.now()
    };
  }
}
