/**
 * Location: src/database/workspaceOwnership.ts
 *
 * The single definition of what a workspace owns, in both stores.
 *
 * Permanent workspace deletion is a human action from the settings UI (the AI
 * only gets the reversible `archiveWorkspace`). It has to remove the workspace
 * AND everything keyed to it, from the JSONL event store first and the SQLite
 * cache second — see `WorkspaceRepository.delete` for the ordering rationale.
 *
 * Two code paths delete a workspace and they MUST agree:
 *
 *  1. `WorkspaceRepository.delete` — the live delete.
 *  2. `WorkspaceEventApplier.applyWorkspaceDeleted` — replay, i.e. what a
 *     `rebuildCache()` or a sync from another device does with a
 *     `workspace_deleted` event.
 *
 * If (2) disagreed with (1), a rebuild would replay `workspace_created`,
 * `session_created`, `state_saved`, `trace_added` … and then a delete that only
 * removed the workspace row — resurrecting every child as an orphan. That is
 * exactly the defect this module exists to prevent, and it is why the purge
 * lives here instead of being written twice.
 *
 * NOT owned by a workspace, deliberately:
 * - `conversations` (and `conversation_embedding_metadata`). `workspaceId` is a
 *   nullable back-reference, not ownership: a conversation is a first-class
 *   entity with its own event stream and survives the workspace it was linked
 *   to. Deleting them here would destroy data the user never asked to delete.
 *
 * Related Files:
 * - src/database/schema/schema.ts — the FK CASCADE declarations that do NOT
 *   fire, because FK enforcement is off on the shared connection (SQLite's
 *   per-connection default; the schema says so for `note_properties` too).
 * - src/database/repositories/WorkspaceRepository.ts
 * - src/database/sync/WorkspaceEventApplier.ts
 */

type PurgeParams = Array<string | number | null | boolean>;

/**
 * Minimal SQLite surface the purge needs. Satisfied by both
 * `SQLiteCacheManager` (repository path) and `ISQLiteCacheManager` (replay path).
 */
export interface WorkspacePurgeTarget {
  run(sql: string, params?: PurgeParams): Promise<unknown>;
  query<T>(sql: string, params?: PurgeParams): Promise<T[]>;
}

/**
 * Every SQLite table keyed to a workspace, in child-before-parent order.
 *
 * Order matters even without FK enforcement: `task_dependencies` and
 * `task_note_links` are reached THROUGH `tasks`, so the `tasks` rows have to
 * still be there when those two run.
 *
 * `workspace_fts` is absent on purpose — an `AFTER DELETE ON workspaces`
 * trigger maintains it (schema.ts), and that trigger does fire.
 */
const WORKSPACE_OWNED_DELETES: readonly string[] = [
  // Task graph edges, resolved through the workspace's tasks.
  `DELETE FROM task_dependencies
     WHERE taskId IN (SELECT id FROM tasks WHERE workspaceId = ?)
        OR dependsOnTaskId IN (SELECT id FROM tasks WHERE workspaceId = ?)`,
  `DELETE FROM task_note_links
     WHERE taskId IN (SELECT id FROM tasks WHERE workspaceId = ?)`,
  'DELETE FROM tasks WHERE workspaceId = ?',
  'DELETE FROM projects WHERE workspaceId = ?',
  'DELETE FROM memory_traces WHERE workspaceId = ?',
  'DELETE FROM states WHERE workspaceId = ?',
  'DELETE FROM sessions WHERE workspaceId = ?',
  // Tool operation receipts carry a NOT NULL workspaceId and are appended to the
  // workspace's own stream (`ToolOperationRepository.path`), so they are owned on
  // both sides — unlike `conversations`, whose workspaceId is nullable. Removing
  // the stream already handles the JSONL half; without this line the SQLite half
  // would be left behind exactly like the other children were.
  'DELETE FROM tool_operation_receipts WHERE workspaceId = ?',
  'DELETE FROM workspaces WHERE id = ?'
];

/** How many `?` placeholders each statement above takes. */
function placeholderCount(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

/**
 * Delete every SQLite row the workspace owns, including the workspace row.
 *
 * Idempotent: re-running against an already-purged workspace is a no-op, which
 * is what makes a failed delete safe to retry.
 *
 * Callers are expected to wrap this in a transaction where one is available.
 */
export async function purgeWorkspaceRows(
  sqlite: WorkspacePurgeTarget,
  workspaceId: string
): Promise<void> {
  // Trace embeddings are a vec0 virtual table keyed by the metadata rowid, so
  // they cannot be reached by a workspaceId predicate. `clearAllData` does not
  // clear them either (embeddings are not replayable from JSONL), so nothing
  // else would ever collect these rows. Same two-step delete as
  // TraceEmbeddingService.
  const embeddingRows = await sqlite.query<{ rowid: number }>(
    'SELECT rowid FROM trace_embedding_metadata WHERE workspaceId = ?',
    [workspaceId]
  );
  for (const row of embeddingRows) {
    await sqlite.run('DELETE FROM trace_embeddings WHERE rowid = ?', [row.rowid]);
  }
  await sqlite.run('DELETE FROM trace_embedding_metadata WHERE workspaceId = ?', [workspaceId]);

  for (const sql of WORKSPACE_OWNED_DELETES) {
    const params: PurgeParams = Array.from(
      { length: placeholderCount(sql) },
      () => workspaceId
    );
    await sqlite.run(sql, params);
  }
}

/**
 * Every JSONL stream a workspace owns, as logical paths for `JSONLWriter`.
 *
 * There are two, not one. Workspace/session/state/trace events live in the
 * workspace stream; project/task events live in a SEPARATE `tasks_<id>` stream
 * (see `TaskRepository.jsonlPath` / `ProjectRepository.jsonlPath`). Removing
 * only the first leaves the tasks stream to be replayed in full by the next
 * `rebuildCache()`.
 *
 * The order is removal order and it is deliberate: the workspace stream is the
 * one carrying the `workspace_deleted` tombstone, so it goes LAST. If removal
 * fails partway, the tombstone is still on disk and the next rebuild still
 * resolves to "deleted" instead of resurrecting the workspace.
 */
export function workspaceOwnedStreamPaths(workspaceId: string): string[] {
  return [
    `tasks/tasks_${workspaceId}.jsonl`,
    `workspaces/ws_${workspaceId}.jsonl`
  ];
}
