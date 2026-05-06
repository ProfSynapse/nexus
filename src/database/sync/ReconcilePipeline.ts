/**
 * Location: src/database/sync/ReconcilePipeline.ts
 *
 * Sync-safe reconcile between JSONL shards (source of truth on disk) and the
 * SQLite cache. Implements the three-layer idempotency contract from
 * `docs/plans/sync-safe-storage-reconcile-plan.md`:
 *
 *   Layer 1 — `shard_cursors` fast-path: per `(deviceId, shardPath)` cursor
 *             stores the last applied event id + timestamp. If the shard's
 *             tail event matches the cursor, the shard is skipped entirely.
 *   Layer 2 — `applied_events` PK: every event id is checked against the
 *             applied set during apply. Defense-in-depth catches duplicates
 *             that slip past the cursor (e.g., conflict-copy siblings, file
 *             rewrites, multi-device replay).
 *   Layer 3 — `INSERT OR REPLACE` in entity tables (handled inside the event
 *             appliers): last-writer-wins for genuine concurrent edits.
 *
 * The pipeline reads shards via `VaultEventStore`, which now matches conflict
 * copies thanks to the regex relax in `ShardedJsonlStreamStore` /
 * `JsonlVaultWatcher`. Cursors are keyed by the FULL shard filename — a
 * canonical `shard-000001.jsonl` and its sibling `shard-000001 (1).jsonl`
 * hold disjoint event sets and need separate cursor rows. Do NOT collapse
 * cursors by `baseIndex`.
 *
 * Silent-overwrite handling (architect §6, user's reported incident pattern):
 * if `cursor.lastEventId` is no longer present in the shard's content, we
 * treat the file as "replaced" and rescan from offset 0. The applied_events
 * PK lookup catches duplicates idempotently.
 *
 * Public surface:
 *   - `reconcileAll()`         — full sweep across kinds × streams × shards
 *   - `reconcileStream(kind, streamId)` — scoped to one logical stream
 *   - `reconcileShard(shardPath)` — scoped to a single shard, used by the
 *                                   vault watcher for auto-heal-on-sync
 *
 * Related:
 * - src/database/storage/SQLiteSyncStateStore.ts — cursor + applied_events store
 * - src/database/storage/vaultRoot/VaultEventStore.ts — shard reader
 * - src/database/sync/{Workspace,Conversation,Task}EventApplier.ts — entity writes
 */

import {
  EVENT_STREAM_CATEGORIES,
  type EventStreamCategory
} from '../storage/vaultRoot/EventStreamUtilities';
import type { VaultEventStore } from '../storage/vaultRoot/VaultEventStore';
import type { SQLiteSyncStateStore, ShardCursor } from '../storage/SQLiteSyncStateStore';
import type {
  StorageEvent,
  WorkspaceEvent,
  ConversationEvent,
  TaskEvent
} from '../interfaces/StorageEvents';
import type { ISQLiteCacheManager } from './SyncCoordinator';
import type { WorkspaceEventApplier } from './WorkspaceEventApplier';
import type { ConversationEventApplier } from './ConversationEventApplier';
import type { TaskEventApplier } from './TaskEventApplier';

export interface ReconcileResult {
  success: boolean;
  /** Events newly written to cache. */
  eventsApplied: number;
  /** Duplicates caught by the `applied_events` PK during this run. */
  eventsSkipped: number;
  /** Shards actually read (parsed). */
  shardsScanned: number;
  /** Shards skipped entirely via cursor fast-path. */
  shardsFastPathed: number;
  /** Shards that triggered a silent-overwrite rescan (cursor stale). */
  silentOverwriteRescans: number;
  errors: string[];
  /** Wall-clock duration in milliseconds. */
  duration: number;
}

export interface ReconcilePipelineOptions {
  vaultEventStore: VaultEventStore;
  syncStateStore: SQLiteSyncStateStore;
  sqliteCache: ISQLiteCacheManager;
  workspaceApplier: WorkspaceEventApplier;
  conversationApplier: ConversationEventApplier;
  taskApplier: TaskEventApplier;
  /** Owning device id. Used as the cursor partition key. */
  deviceId: string;
}

/** Minimum event shape consumed by the pipeline. All storage events satisfy this. */
type AnyStorageEvent = StorageEvent & { id: string; timestamp: number; deviceId?: string };

const BUSINESS_ID_PREFIX: Record<EventStreamCategory, string> = {
  conversations: 'conv_',
  workspaces: 'ws_',
  tasks: 'tasks_'
};

export interface ParsedShardPath {
  category: EventStreamCategory;
  streamId: string;
  /** Per-category business id (suffix after `BUSINESS_ID_PREFIX`). Used as `workspaceKey`. */
  businessId: string;
  shardFileName: string;
}

export class ReconcilePipeline {
  private readonly vaultEventStore: VaultEventStore;
  private readonly syncStateStore: SQLiteSyncStateStore;
  private readonly sqliteCache: ISQLiteCacheManager;
  private readonly workspaceApplier: WorkspaceEventApplier;
  private readonly conversationApplier: ConversationEventApplier;
  private readonly taskApplier: TaskEventApplier;
  private readonly deviceId: string;

  constructor(options: ReconcilePipelineOptions) {
    this.vaultEventStore = options.vaultEventStore;
    this.syncStateStore = options.syncStateStore;
    this.sqliteCache = options.sqliteCache;
    this.workspaceApplier = options.workspaceApplier;
    this.conversationApplier = options.conversationApplier;
    this.taskApplier = options.taskApplier;
    this.deviceId = options.deviceId;
  }

  /**
   * Full sweep across all categories × streams × shards. Used by manual
   * "Refresh synced data" command and by `SyncCoordinator.sync()`.
   */
  async reconcileAll(): Promise<ReconcileResult> {
    const start = Date.now();
    const totals = this.emptyTotals();

    for (const category of EVENT_STREAM_CATEGORIES) {
      const streamPaths = await this.vaultEventStore.listFiles(category);
      for (const streamPath of streamPaths) {
        const streamId = this.streamIdFromLogicalPath(category, streamPath);
        if (!streamId) {
          continue;
        }
        try {
          const result = await this.reconcileStreamInternal(category, streamId);
          this.accumulate(totals, result);
        } catch (error) {
          totals.errors.push(`Failed to reconcile ${category}/${streamId}: ${String(error)}`);
        }
      }
    }

    return this.finalize(totals, start);
  }

  /**
   * Scoped reconcile for a single logical stream (e.g. `conversations/conv_abc`).
   * Reads all shards under that stream and reconciles each.
   */
  async reconcileStream(category: EventStreamCategory, streamId: string): Promise<ReconcileResult> {
    const start = Date.now();
    const totals = this.emptyTotals();

    try {
      const result = await this.reconcileStreamInternal(category, streamId);
      this.accumulate(totals, result);
    } catch (error) {
      totals.errors.push(`Failed to reconcile ${category}/${streamId}: ${String(error)}`);
    }

    return this.finalize(totals, start);
  }

  /**
   * Scoped reconcile for a single shard, identified by its full vault-relative
   * path (e.g. `Nexus/data/tasks/tasks_xyz/shard-000001.jsonl` or a conflict
   * sibling). Used by `JsonlVaultWatcher`'s onChange callback.
   *
   * Silent-overwrite path: if the cursor's `lastEventId` is no longer present
   * in the shard content, the cursor is treated as stale and the shard is
   * rescanned from offset 0. `applied_events` deduplicates redundant writes.
   */
  async reconcileShard(shardPath: string): Promise<ReconcileResult> {
    const start = Date.now();
    const totals = this.emptyTotals();

    const parsed = parseShardVaultPath(shardPath, this.vaultEventStore.getRootPath());
    if (!parsed) {
      totals.errors.push(`Cannot parse shard path: ${shardPath}`);
      return this.finalize(totals, start);
    }

    try {
      const result = await this.reconcileSingleShard(parsed);
      this.accumulate(totals, result);
    } catch (error) {
      totals.errors.push(`Failed to reconcile shard ${shardPath}: ${String(error)}`);
    }

    return this.finalize(totals, start);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async reconcileStreamInternal(
    category: EventStreamCategory,
    streamId: string
  ): Promise<ReconcileResult> {
    const totals = this.emptyTotals();
    const start = Date.now();
    const handle = this.getStreamHandle(category, streamId);
    const shards = await handle.shardStore.listShards(handle.relativeStreamPath);

    for (const shard of shards) {
      const businessId = this.businessIdFromStreamId(category, streamId);
      const result = await this.reconcileSingleShard({
        category,
        streamId,
        businessId,
        shardFileName: shard.fileName
      });
      this.accumulate(totals, result);
    }

    return this.finalize(totals, start);
  }

  private async reconcileSingleShard(parsed: ParsedShardPath): Promise<ReconcileResult> {
    const totals = this.emptyTotals();
    const start = Date.now();

    const handle = this.getStreamHandle(parsed.category, parsed.streamId);
    const shardFullPath = `${handle.absoluteStreamPath}/${parsed.shardFileName}`;
    const cursor = await this.syncStateStore.getCursor(this.deviceId, shardFullPath);

    // Read all events in the shard. Phase 1 keeps this simple: we always read
    // the full shard if the cursor fast-path fails. Byte-offset incremental
    // reads are a future optimization — applied_events PK already keeps the
    // apply path O(1) per duplicate event.
    const events = await this.readShardEvents(handle, parsed.shardFileName);

    // Layer 1 — cursor fast-path: if the last applied event matches the
    // shard's tail event, this shard has no new events for us.
    if (cursor && this.isCursorAtTail(cursor, events)) {
      totals.shardsFastPathed = 1;
      return this.finalize(totals, start);
    }

    // Silent-overwrite detection: cursor exists, points to an event that is
    // no longer in the file. The file was replaced (or truncated by sync).
    // Treat as full rescan; applied_events catches the duplicates.
    if (cursor && cursor.lastEventId !== null && !events.some((e) => e.id === cursor.lastEventId)) {
      totals.silentOverwriteRescans = 1;
    }

    totals.shardsScanned = 1;

    // Deterministic ordering: (timestamp ASC, deviceId ASC, eventId ASC).
    const sorted = [...events].sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      const ad = a.deviceId ?? '';
      const bd = b.deviceId ?? '';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    for (const event of sorted) {
      try {
        if (await this.sqliteCache.isEventApplied(event.id)) {
          totals.eventsSkipped += 1;
          continue;
        }
        await this.applyEvent(parsed.category, event);
        await this.sqliteCache.markEventApplied(event.id);
        totals.eventsApplied += 1;
      } catch (error) {
        totals.errors.push(`apply ${parsed.category}/${event.id}: ${String(error)}`);
      }
    }

    // Cursor advances to the tail of the sorted run regardless of whether new
    // events were applied. A re-run after a partial failure still fast-paths
    // correctly because the tail event lives in `applied_events` (Layer 2).
    const tail = sorted.length > 0 ? sorted[sorted.length - 1] : null;
    const nextCursor: ShardCursor = {
      deviceId: this.deviceId,
      shardPath: shardFullPath,
      lastEventId: tail?.id ?? cursor?.lastEventId ?? null,
      // Phase 1 stores 0 for byte-offset; future optimization will track real bytes.
      lastOffset: 0,
      lastTimestamp: tail?.timestamp ?? cursor?.lastTimestamp ?? 0,
      kind: parsed.category,
      workspaceKey: parsed.businessId || null,
      updatedAt: Date.now()
    };
    await this.syncStateStore.upsertCursor(nextCursor);

    return this.finalize(totals, start);
  }

  private isCursorAtTail(cursor: ShardCursor, events: AnyStorageEvent[]): boolean {
    if (cursor.lastEventId === null || events.length === 0) {
      return false;
    }
    const tail = events[events.length - 1];
    if (tail.id !== cursor.lastEventId) {
      return false;
    }
    if (Number.isFinite(cursor.lastTimestamp) && cursor.lastTimestamp !== tail.timestamp) {
      return false;
    }
    return true;
  }

  private async readShardEvents(
    handle: ReturnType<VaultEventStore['getConversationStream']>,
    shardFileName: string
  ): Promise<AnyStorageEvent[]> {
    // Locate the target shard's full path via listShards, then read its
    // bytes directly. We avoid `shardStore.readEvents()` because that would
    // aggregate every shard in the stream, defeating the per-shard scope.
    //
    // Future optimization: add a single-shard read API to
    // `ShardedJsonlStreamStore` that returns the raw content stream by index.
    const shards = await handle.shardStore.listShards(handle.relativeStreamPath);
    const target = shards.find((s) => s.fileName === shardFileName);
    if (!target) {
      return [];
    }
    return readEventsFromShardFile(handle, target.fullPath);
  }

  private async applyEvent(category: EventStreamCategory, event: AnyStorageEvent): Promise<void> {
    switch (category) {
      case 'workspaces':
        await this.workspaceApplier.apply(event as unknown as WorkspaceEvent);
        return;
      case 'conversations':
        await this.conversationApplier.apply(event as unknown as ConversationEvent);
        return;
      case 'tasks':
        await this.taskApplier.apply(event as unknown as TaskEvent);
        return;
    }
  }

  private getStreamHandle(category: EventStreamCategory, streamId: string) {
    switch (category) {
      case 'conversations':
        return this.vaultEventStore.getConversationStream(streamId);
      case 'workspaces':
        return this.vaultEventStore.getWorkspaceStream(streamId);
      case 'tasks':
        return this.vaultEventStore.getTaskStream(streamId);
    }
  }

  private streamIdFromLogicalPath(category: EventStreamCategory, logicalPath: string): string | null {
    // logicalPath shape: `<category>/<streamId>.jsonl` (per VaultEventStore.listFiles)
    const prefix = `${category}/`;
    if (!logicalPath.startsWith(prefix)) return null;
    const remainder = logicalPath.slice(prefix.length);
    return remainder.endsWith('.jsonl')
      ? remainder.slice(0, -'.jsonl'.length)
      : remainder;
  }

  private businessIdFromStreamId(category: EventStreamCategory, streamId: string): string {
    const prefix = BUSINESS_ID_PREFIX[category];
    return streamId.startsWith(prefix) ? streamId.slice(prefix.length) : streamId;
  }

  private emptyTotals(): ReconcileResult {
    return {
      success: true,
      eventsApplied: 0,
      eventsSkipped: 0,
      shardsScanned: 0,
      shardsFastPathed: 0,
      silentOverwriteRescans: 0,
      errors: [],
      duration: 0
    };
  }

  private accumulate(into: ReconcileResult, from: ReconcileResult): void {
    into.eventsApplied += from.eventsApplied;
    into.eventsSkipped += from.eventsSkipped;
    into.shardsScanned += from.shardsScanned;
    into.shardsFastPathed += from.shardsFastPathed;
    into.silentOverwriteRescans += from.silentOverwriteRescans;
    into.errors.push(...from.errors);
  }

  private finalize(result: ReconcileResult, start: number): ReconcileResult {
    result.duration = Date.now() - start;
    result.success = result.errors.length === 0;
    return result;
  }
}

/**
 * Parse a vault-relative shard path into category / stream id / shard filename.
 * Accepts canonical shards and conflict-copy siblings (the `MATCH_SHARDED`
 * regex in `JsonlVaultWatcher` is permissive; this parser is symmetric).
 *
 * Returns `null` for non-shard paths or paths outside the data root.
 */
export function parseShardVaultPath(
  shardPath: string,
  dataRoot: string
): ParsedShardPath | null {
  const trimmedRoot = dataRoot.replace(/\/+$/, '');
  const normalized = shardPath.replace(/^\/+/, '');
  const prefix = `${trimmedRoot}/`;
  if (!normalized.startsWith(prefix)) {
    return null;
  }
  const rel = normalized.slice(prefix.length);
  // Expected shape: `<category>/<streamId>/<shardFileName>`
  const parts = rel.split('/');
  if (parts.length !== 3) {
    return null;
  }
  const [category, streamId, shardFileName] = parts;
  if (category !== 'conversations' && category !== 'workspaces' && category !== 'tasks') {
    return null;
  }
  if (!shardFileName.endsWith('.jsonl')) {
    return null;
  }
  const cat = category as EventStreamCategory;
  const businessIdPrefix = BUSINESS_ID_PREFIX[cat];
  const businessId = streamId.startsWith(businessIdPrefix)
    ? streamId.slice(businessIdPrefix.length)
    : streamId;

  return {
    category: cat,
    streamId,
    businessId,
    shardFileName
  };
}

/**
 * Read JSONL events directly from a single shard file. Bypasses the stream
 * store's multi-shard readEvents to avoid re-reading the whole stream.
 */
async function readEventsFromShardFile(
  handle: ReturnType<VaultEventStore['getConversationStream']>,
  shardFullPath: string
): Promise<AnyStorageEvent[]> {
  const adapter = (handle.shardStore as unknown as {
    app: { vault: { adapter: { read(path: string): Promise<string>; exists(path: string): Promise<boolean> } } };
  }).app.vault.adapter;

  if (!(await adapter.exists(shardFullPath))) {
    return [];
  }
  const content = await adapter.read(shardFullPath);
  if (!content.trim()) {
    return [];
  }

  const events: AnyStorageEvent[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as AnyStorageEvent);
    } catch {
      // Match the existing ShardedJsonlStreamStore behavior — skip malformed.
      console.warn(`[ReconcilePipeline] Skipping malformed line in ${shardFullPath}`);
    }
  }
  return events;
}
