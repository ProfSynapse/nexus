import type { QueryParams } from '../repositories/base/BaseRepository';
import type { RunResult } from '../interfaces/IStorageBackend';
import type { SyncState } from '../sync/SyncCoordinator';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type QueryFn = <T>(sql: string, params?: QueryParams) => Promise<T[]>;
type QueryOneFn = <T>(sql: string, params?: QueryParams) => Promise<T | null>;
type RunFn = (sql: string, params?: QueryParams) => Promise<RunResult>;

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
}
