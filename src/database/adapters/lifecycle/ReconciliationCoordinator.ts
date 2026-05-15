import { JSONLWriter } from '../../storage/JSONLWriter';
import { SQLiteCacheManager } from '../../storage/SQLiteCacheManager';
import type { StorageEvent } from '../../interfaces/StorageEvents';

/**
 * Generic "JSONL → SQLite" reconciliation pass.
 *
 * Previously `reconcileMissingWorkspaces` / `reconcileMissingConversations`
 * / `reconcileMissingTasks` were near-identical loops differing only in:
 *   - the JSONL subdir
 *   - the filename → entity-id regex
 *   - the per-event applier
 *   - the "does this entity already exist in SQLite?" probe
 *   - the per-category "skip this file entirely?" predicate
 *
 * Those four bits are now category descriptors; the loop is one place.
 */
export interface ReconcileCategory<Event extends StorageEvent> {
  /** Human-readable label used in error logs (e.g. "workspace", "conversation"). */
  readonly label: string;
  /** JSONL subdir under the plugin data root. */
  readonly subdir: 'workspaces' | 'conversations' | 'tasks';
  /**
   * Filename regex with one capture group: the per-file entity identifier.
   * Files that don't match are skipped silently.
   */
  readonly filenameRegex: RegExp;
  /** True if the entity is already present in SQLite (skip the file). */
  existsInCache(entityId: string): Promise<boolean>;
  /**
   * Per-category short-circuit run BEFORE we replay events. Return true to
   * skip the file (e.g. workspace_deleted present, or no metadata event yet).
   */
  shouldSkipEvents(events: Event[]): boolean;
  /** Apply a single event to SQLite. */
  applyEvent(event: Event): Promise<void>;
}

export class ReconciliationCoordinator {
  constructor(
    private readonly jsonlWriter: JSONLWriter,
    private readonly sqliteCache: SQLiteCacheManager
  ) {}

  async reconcile<Event extends StorageEvent>(
    category: ReconcileCategory<Event>
  ): Promise<number> {
    const files = await this.jsonlWriter.listFiles(category.subdir);
    if (files.length === 0) return 0;

    let reconciled = 0;
    for (const file of files) {
      const match = file.match(category.filenameRegex);
      if (!match) continue;
      const entityId = match[1];

      if (await category.existsInCache(entityId)) continue;

      try {
        const events = await this.jsonlWriter.readEvents<Event>(file);
        events.sort((a, b) => a.timestamp - b.timestamp);

        if (category.shouldSkipEvents(events)) continue;

        for (const event of events) {
          await category.applyEvent(event);
        }
        reconciled++;
      } catch (e) {
        console.error(`[HybridStorageAdapter] Failed to reconcile ${category.label} ${entityId}:`, e);
      }
    }

    if (reconciled > 0) {
      await this.sqliteCache.save();
    }
    return reconciled;
  }
}
