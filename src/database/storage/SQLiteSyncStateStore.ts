import type { QueryParams } from '../repositories/base/BaseRepository';
import type { RunResult } from '../interfaces/IStorageBackend';
import type { SyncState } from '../sync/SyncCoordinator';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type QueryFn = <T>(sql: string, params?: QueryParams) => Promise<T[]>;
type QueryOneFn = <T>(sql: string, params?: QueryParams) => Promise<T | null>;
type RunFn = (sql: string, params?: QueryParams) => Promise<RunResult>;

/**
 * Per-shard reconcile cursor. `shardPath` is the FULL filename (canonical or
 * conflict-suffixed); a canonical shard and its conflict sibling are physically
 * distinct files holding disjoint event sets, so each gets its own row.
 */
export interface ShardCursor {
  deviceId: string;
  shardPath: string;
  lastEventId: string | null;
  lastOffset: number;
  lastTimestamp: number;
  kind: string;
  workspaceKey: string | null;
  updatedAt: number;
}

export interface ShardCursorFilter {
  deviceId?: string;
  shardPath?: string;
  kind?: string;
}

interface ShardCursorRow {
  deviceId: string;
  shardPath: string;
  lastEventId: string | null;
  lastOffset: number;
  lastTimestamp: number;
  kind: string;
  workspaceKey: string | null;
  updatedAt: number;
}

function rowToCursor(row: ShardCursorRow): ShardCursor {
  return {
    deviceId: row.deviceId,
    shardPath: row.shardPath,
    lastEventId: row.lastEventId,
    lastOffset: row.lastOffset,
    lastTimestamp: row.lastTimestamp,
    kind: row.kind,
    workspaceKey: row.workspaceKey,
    updatedAt: row.updatedAt
  };
}

export class SQLiteSyncStateStore {
  constructor(
    private readonly query: QueryFn,
    private readonly queryOne: QueryOneFn,
    private readonly run: RunFn
  ) {}

  async isEventApplied(eventId: string): Promise<boolean> {
    const result = await this.queryOne<{ eventId: string }>(
      'SELECT eventId FROM applied_events WHERE eventId = ?',
      [eventId]
    );
    return result !== null;
  }

  async markEventApplied(eventId: string): Promise<void> {
    await this.run(
      'INSERT OR IGNORE INTO applied_events (eventId, appliedAt) VALUES (?, ?)',
      [eventId, Date.now()]
    );
  }

  async getAppliedEventsAfter(timestamp: number): Promise<string[]> {
    const results = await this.query<{ eventId: string }>(
      'SELECT eventId FROM applied_events WHERE appliedAt > ? ORDER BY appliedAt',
      [timestamp]
    );
    return results.map(result => result.eventId);
  }

  async getSyncState(deviceId: string): Promise<SyncState | null> {
    const result = await this.queryOne<{ deviceId: string; lastEventTimestamp: number; syncedFilesJson: string }>(
      'SELECT deviceId, lastEventTimestamp, syncedFilesJson FROM sync_state WHERE deviceId = ?',
      [deviceId]
    );

    if (!result) {
      return null;
    }

    const fileTimestampsRaw: unknown = result.syncedFilesJson ? JSON.parse(result.syncedFilesJson) : {};
    const fileTimestamps: Record<string, number> = {};
    if (isRecord(fileTimestampsRaw)) {
      for (const [key, value] of Object.entries(fileTimestampsRaw)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          fileTimestamps[key] = value;
        }
      }
    }

    return {
      deviceId: result.deviceId,
      lastEventTimestamp: result.lastEventTimestamp,
      fileTimestamps
    };
  }

  async updateSyncState(
    deviceId: string,
    lastEventTimestamp: number,
    fileTimestamps: Record<string, number>
  ): Promise<void> {
    await this.run(
      `INSERT OR REPLACE INTO sync_state (deviceId, lastEventTimestamp, syncedFilesJson)
       VALUES (?, ?, ?)`,
      [deviceId, lastEventTimestamp, JSON.stringify(fileTimestamps)]
    );
  }

  async getCursor(deviceId: string, shardPath: string): Promise<ShardCursor | null> {
    const row = await this.queryOne<ShardCursorRow>(
      `SELECT deviceId, shardPath, lastEventId, lastOffset, lastTimestamp, kind, workspaceKey, updatedAt
       FROM shard_cursors
       WHERE deviceId = ? AND shardPath = ?`,
      [deviceId, shardPath]
    );
    return row ? rowToCursor(row) : null;
  }

  async upsertCursor(cursor: ShardCursor): Promise<void> {
    await this.run(
      `INSERT OR REPLACE INTO shard_cursors
       (deviceId, shardPath, lastEventId, lastOffset, lastTimestamp, kind, workspaceKey, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cursor.deviceId,
        cursor.shardPath,
        cursor.lastEventId,
        cursor.lastOffset,
        cursor.lastTimestamp,
        cursor.kind,
        cursor.workspaceKey,
        cursor.updatedAt
      ]
    );
  }

  async listCursors(filter?: ShardCursorFilter): Promise<ShardCursor[]> {
    const clauses: string[] = [];
    const params: QueryParams = [];

    if (filter?.deviceId !== undefined) {
      clauses.push('deviceId = ?');
      params.push(filter.deviceId);
    }
    if (filter?.shardPath !== undefined) {
      clauses.push('shardPath = ?');
      params.push(filter.shardPath);
    }
    if (filter?.kind !== undefined) {
      clauses.push('kind = ?');
      params.push(filter.kind);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.query<ShardCursorRow>(
      `SELECT deviceId, shardPath, lastEventId, lastOffset, lastTimestamp, kind, workspaceKey, updatedAt
       FROM shard_cursors${where}
       ORDER BY shardPath`,
      params.length > 0 ? params : undefined
    );

    return rows.map(rowToCursor);
  }
}
