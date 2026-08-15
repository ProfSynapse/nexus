/**
 * Location: src/database/sessionOwnership.ts
 *
 * The single definition of what a session owns in the SQLite cache.
 *
 * Sibling of `workspaceOwnership.ts` and `taskOwnership.ts`, and it exists for
 * the same reason: two code paths delete a session and they MUST agree.
 *
 *  1. `SessionRepository.delete` — the live delete.
 *  2. `WorkspaceEventApplier.applySessionDeleted` — replay, i.e. what a
 *     `rebuildCache()` or a sync from another device does with a
 *     `session_deleted` event.
 *
 * If (2) disagreed with (1), a rebuild would replay `session_created`,
 * `state_saved`, `trace_added` … and then a delete that only removed the
 * `sessions` row, resurrecting every state and trace as an orphan.
 *
 * Measured against the pre-fix code in a real vault (Obsidian 1.13.7, headless):
 * deleting a session holding 2 states / 2 traces / 1 trace embedding left
 * `states 2, memory_traces 2, trace_embedding_metadata 1` behind, and the next
 * `rebuildCache()` put the session itself back (`sessions 0 → 1`) because no
 * event was ever written.
 *
 * ## What a session does NOT own
 *
 * - **Its JSONL stream.** A session has no stream of its own: session, state and
 *   trace events are all appended to the *workspace's* stream
 *   (`SessionRepository.jsonlPath`). Removing that file would destroy the
 *   workspace and its sibling sessions, so a session delete is a tombstone-only
 *   operation — `session_deleted` cancels the earlier events out on replay.
 * - **`conversations` (and `conversation_embedding_metadata`).** `sessionId` is a
 *   nullable back-reference, not ownership — same call as `workspaceOwnership.ts`.
 *   A conversation is a first-class entity with its own event stream and outlives
 *   the session it was linked to. (Measured aside: replay does not restore
 *   `conversations.sessionId` at all, so it is not even a reliable link.)
 *
 * Related Files:
 * - src/database/schema/schema.ts — the FK CASCADE declarations that do NOT
 *   fire, because FK enforcement is off on the shared connection.
 * - src/database/repositories/SessionRepository.ts
 * - src/database/sync/WorkspaceEventApplier.ts
 */

type PurgeParams = Array<string | number | null | boolean>;

/**
 * Minimal SQLite surface the purge needs. Satisfied by both
 * `SQLiteCacheManager` (repository path) and `ISQLiteCacheManager` (replay path).
 */
export interface SessionPurgeTarget {
  run(sql: string, params?: PurgeParams): Promise<unknown>;
  query<T>(sql: string, params?: PurgeParams): Promise<T[]>;
}

/**
 * Every SQLite table keyed to a session, in child-before-parent order.
 *
 * `states` and `memory_traces` declare `ON DELETE CASCADE` on `sessionId`; the
 * cascade never fires, so they are listed here explicitly. The `sessions` row
 * goes last so nothing is orphaned mid-purge.
 *
 * No FTS table is keyed to a session (`workspace_fts` tracks workspaces and is
 * maintained by a trigger that does fire), so none is listed.
 */
const SESSION_OWNED_DELETES: readonly string[] = [
  'DELETE FROM states WHERE sessionId = ?',
  'DELETE FROM memory_traces WHERE sessionId = ?',
  'DELETE FROM sessions WHERE id = ?'
];

/**
 * Delete every SQLite row the session owns, including the session row.
 *
 * Idempotent: re-running against an already-purged session is a no-op, which is
 * what makes a failed delete safe to retry.
 *
 * Callers are expected to wrap this in a transaction where one is available.
 */
export async function purgeSessionRows(
  sqlite: SessionPurgeTarget,
  sessionId: string
): Promise<void> {
  // Trace embeddings are a vec0 virtual table keyed by the metadata rowid, so
  // they cannot be reached by a sessionId predicate. Same two-step delete as
  // TraceEmbeddingService and `purgeWorkspaceRows`. This runs first, while the
  // metadata rows that name the rowids are still there.
  const embeddingRows = await sqlite.query<{ rowid: number }>(
    'SELECT rowid FROM trace_embedding_metadata WHERE sessionId = ?',
    [sessionId]
  );
  for (const row of embeddingRows) {
    await sqlite.run('DELETE FROM trace_embeddings WHERE rowid = ?', [row.rowid]);
  }
  await sqlite.run('DELETE FROM trace_embedding_metadata WHERE sessionId = ?', [sessionId]);

  for (const sql of SESSION_OWNED_DELETES) {
    await sqlite.run(sql, [sessionId]);
  }
}
