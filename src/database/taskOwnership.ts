/**
 * Location: src/database/taskOwnership.ts
 *
 * The single definition of what a project and a task own in the SQLite cache.
 *
 * Sibling of `sessionOwnership.ts` (and `workspaceOwnership.ts`), for the same
 * reason: two code paths delete each of these and they MUST agree.
 *
 *  1. `ProjectRepository.delete` / `TaskRepository.delete` — the live delete.
 *  2. `TaskEventApplier.applyProjectDeleted` / `applyTaskDeleted` — replay, i.e.
 *     what a `rebuildCache()` or a sync from another device does with the
 *     `project_deleted` / `task_deleted` event.
 *
 * Both sides said "CASCADE will handle it". It does not: SQLite foreign-key
 * enforcement is per-connection and off by default, and nothing in this plugin
 * turns it on, so every `ON DELETE CASCADE` in `schema.ts` is documentation.
 *
 * Measured against the pre-fix code in a real vault (Obsidian 1.13.7, headless):
 *
 * - Deleting a project with 3 tasks (1 dependency edge, 1 note link) removed the
 *   `projects` row and left `tasks 3, task_dependencies 1, task_note_links 1`.
 *   `rebuildCache()` reproduced exactly the same orphans, because replay applies
 *   `task_created` and then a `project_deleted` that only dropped the project.
 * - Deleting a single task left `task_dependencies 1, task_note_links 1` and a
 *   child task still pointing at the deleted parent — also reproduced by the
 *   rebuild.
 *
 * Related Files:
 * - src/database/schema/schema.ts — the FK declarations that never fire.
 * - src/database/repositories/ProjectRepository.ts
 * - src/database/repositories/TaskRepository.ts
 * - src/database/sync/TaskEventApplier.ts
 */

type PurgeParams = Array<string | number | null | boolean>;

/**
 * Minimal SQLite surface the purges need. Satisfied by both
 * `SQLiteCacheManager` (repository path) and `ISQLiteCacheManager` (replay path).
 */
export interface TaskPurgeTarget {
  run(sql: string, params?: PurgeParams): Promise<unknown>;
}

/** How many `?` placeholders a statement takes. */
function placeholderCount(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

/**
 * Run statements that all bind the same single id, once per `?`.
 * Same shape as `purgeWorkspaceRows`, so the three ownership modules read alike.
 */
async function runAll(
  sqlite: TaskPurgeTarget,
  statements: readonly string[],
  id: string
): Promise<void> {
  for (const sql of statements) {
    const params: PurgeParams = Array.from({ length: placeholderCount(sql) }, () => id);
    await sqlite.run(sql, params);
  }
}

/**
 * Every SQLite statement a project delete needs, in child-before-parent order.
 *
 * Order is forced by the data, not by taste:
 *  1. `task_dependencies` and `task_note_links` are reached THROUGH `tasks`, so
 *     the task rows must still exist when they run.
 *  2. `parentTaskId` is declared `ON DELETE SET NULL`, not CASCADE — a surviving
 *     task (possibly in another project) that pointed at a removed task must be
 *     detached rather than deleted, or the board would lose unrelated work.
 *  3. Only then the `tasks` rows, and last the `projects` row.
 */
const PROJECT_OWNED_STATEMENTS: readonly string[] = [
  `DELETE FROM task_dependencies
     WHERE taskId IN (SELECT id FROM tasks WHERE projectId = ?)
        OR dependsOnTaskId IN (SELECT id FROM tasks WHERE projectId = ?)`,
  'DELETE FROM task_note_links WHERE taskId IN (SELECT id FROM tasks WHERE projectId = ?)',
  'UPDATE tasks SET parentTaskId = NULL WHERE parentTaskId IN (SELECT id FROM tasks WHERE projectId = ?)',
  'DELETE FROM tasks WHERE projectId = ?',
  'DELETE FROM projects WHERE id = ?'
];

/** The same set for one task, in the same order and for the same reasons. */
const TASK_OWNED_STATEMENTS: readonly string[] = [
  'DELETE FROM task_dependencies WHERE taskId = ? OR dependsOnTaskId = ?',
  'DELETE FROM task_note_links WHERE taskId = ?',
  'UPDATE tasks SET parentTaskId = NULL WHERE parentTaskId = ?',
  'DELETE FROM tasks WHERE id = ?'
];

/**
 * Delete every SQLite row the project owns, including the project row.
 *
 * Idempotent, so a delete that failed partway can be retried whole.
 * Callers are expected to wrap this in a transaction where one is available.
 */
export async function purgeProjectRows(
  sqlite: TaskPurgeTarget,
  projectId: string
): Promise<void> {
  await runAll(sqlite, PROJECT_OWNED_STATEMENTS, projectId);
}

/**
 * Delete every SQLite row a single task owns, including the task row.
 *
 * Sub-tasks are NOT deleted — `parentTaskId` is `ON DELETE SET NULL` in the
 * schema, so a child of a deleted task is detached and survives. Removing it
 * would destroy work the user did not ask to delete, and neither the live path
 * nor the replay path ever claimed to.
 *
 * Idempotent. Callers are expected to wrap this in a transaction where one is
 * available.
 */
export async function purgeTaskRows(
  sqlite: TaskPurgeTarget,
  taskId: string
): Promise<void> {
  await runAll(sqlite, TASK_OWNED_STATEMENTS, taskId);
}
