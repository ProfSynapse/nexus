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

  // 2. Try name match (prefer non-archived workspaces)
  const byName = await sqliteCache.query<{ id: string; lastAccessed: number }>(
    'SELECT id, lastAccessed FROM workspaces WHERE name = ? AND isArchived = 0',
    [rawId]
  );

  if (byName.length === 1) {
    // Single match — use it transparently
    return { id: byName[0].id, resolvedFromName: true };
  }

  if (byName.length > 1) {
    // Multiple matches — return null with nudge listing all UUIDs
    const ids = byName.map(w => w.id);
    return {
      id: null,
      resolvedFromName: false,
      warning: `Multiple workspaces named "${rawId}" found. Please retry with the specific workspace UUID: [${ids.join(', ')}]`,
      matchingIds: ids,
    };
  }
  // 3. No match at all
  return { id: null, resolvedFromName: false };
}
