/**
 * Location: src/database/sync/resolveWorkspaceId.ts
 *
 * Shared workspace ID resolution utility. Transparently resolves workspace
 * names to UUIDs so users and agents never need to know or pass raw UUIDs.
 *
 * Resolution order:
 * 1. Exact UUID match in workspaces table
 * 2. Name match (non-archived) — single match returns UUID transparently
 * 3. Multiple name matches — returns null with warning listing all UUIDs
 * 4. No match — returns null (caller decides: error or fallback)
 *
 * Used by:
 * - TaskEventApplier (rebuild path — normalizes orphaned workspaceIds)
 * - TaskService via AgentInitializationService (runtime validation)
 * - HybridStorageAdapter.reconcileMissingTasks (startup repair)
 */

import { ISQLiteCacheManager } from './SyncCoordinator';

export interface ResolveResult {
  /** The resolved workspace UUID, or null if not found or ambiguous */
  id: string | null;
  /** Whether the input was resolved from a name (not a direct UUID match) */
  resolvedFromName: boolean;
  /** Warning/error message if ambiguous or not found */
  warning?: string;
  /** All matching UUIDs when ambiguous (caller can surface these to the user) */
  matchingIds?: string[];
  /**
   * All matching workspaces when ambiguous, most-recently-accessed first.
   *
   * Carries the NAME alongside the id because the candidates can differ only in
   * capitalization ("Dev" vs "dev"), and a list of bare UUIDs gives the caller
   * no way to tell which is which.
   */
  matches?: Array<{ id: string; name: string }>;
}

/**
 * Resolve a raw workspace identifier (UUID or name) to a workspace UUID.
 *
 * @param rawId - UUID or workspace name string
 * @param sqliteCache - Database access for workspace lookups
 * @returns ResolveResult with the resolved UUID or null
 */
export async function resolveWorkspaceId(
  rawId: string,
  sqliteCache: ISQLiteCacheManager
): Promise<ResolveResult> {
  if (!rawId) {
    return { id: null, resolvedFromName: false };
  }

  // 1. Try exact UUID match
  const byId = await sqliteCache.queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE id = ?',
    [rawId]
  );
  if (byId) {
    return { id: rawId, resolvedFromName: false };
  }

  // 2. Try name match (prefer non-archived workspaces).
  //
  // Case-insensitive, to agree with the other two resolvers:
  // `WorkspaceService.getWorkspaceByNameOrId` (the canonical one) and
  // `ToolBatchExecutionService.validateWorkspaceId` (the envelope guard) both
  // compare lowercased. This one used `name = ?`, so a name differing only in
  // case passed the guard and was then rejected here with "not found" — the
  // gate and the layer behind it disagreeing on the same input (#320).
  //
  // `isArchived = 0` is intentionally unchanged: how a name is compared is a
  // separate decision from which rows are eligible.
  //
  // `idx_workspaces_name` is on the raw column and will not serve LOWER(name),
  // but the table holds single digits to low dozens of rows on real vaults and
  // this branch is only reached after the id lookup misses, so no expression
  // index is warranted yet.
  // `name` is selected so an ambiguous result can name each candidate, and the
  // ordering is explicit so the message is deterministic and leads with the
  // workspace the caller most likely meant.
  const byName = await sqliteCache.query<{ id: string; name: string; lastAccessed: number }>(
    'SELECT id, name, lastAccessed FROM workspaces WHERE LOWER(name) = LOWER(?) AND isArchived = 0 ORDER BY lastAccessed DESC, id ASC',
    [rawId]
  );

  if (byName.length === 1) {
    // Single match — use it transparently
    return { id: byName[0].id, resolvedFromName: true };
  }

  if (byName.length > 1) {
    // Multiple matches. `UNIQUE(name)` on the workspaces table has no
    // COLLATE NOCASE, so it forbids exact duplicates while permitting
    // case-variants — which means two rows can only land here by differing in
    // capitalization, and the message below can say so as fact. It also means a
    // bare id list is useless: the names look identical to the caller, so each
    // NAME must be paired with its own id.
    const matches = byName.map(w => ({ id: w.id, name: w.name }));
    const listed = matches.map(m => `  - "${m.name}" — ${m.id}`).join('\n');
    return {
      id: null,
      resolvedFromName: false,
      warning:
        `Multiple workspaces match the name "${rawId}":\n${listed}\n` +
        'They differ only in capitalization, so the name is ambiguous. Retry with ' +
        'workspaceId set to the id of the one you want (copied exactly from above), not the name.',
      matchingIds: matches.map(m => m.id),
      matches,
    };
  }
  // 3. No match at all
  return { id: null, resolvedFromName: false };
}
