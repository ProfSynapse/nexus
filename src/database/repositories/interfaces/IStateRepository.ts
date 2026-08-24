/**
 * Location: src/database/repositories/interfaces/IStateRepository.ts
 *
 * State Repository Interface
 *
 * Defines state-specific operations for managing workspace state snapshots.
 * States are named snapshots that can be resumed later to continue work.
 *
 * Related Files:
 * - src/database/repositories/StateRepository.ts - Implementation
 * - src/types/storage/HybridStorageTypes.ts - StateMetadata, StateData types
 */

import { IRepository } from './IRepository';
import { StateMetadata, StateData } from '../../../types/storage/HybridStorageTypes';
import { PaginatedResult, PaginationParams } from '../../../types/pagination/PaginationTypes';

/**
 * Data required to create/save a state
 */
export interface SaveStateData {
  name: string;
  description?: string;
  created?: number;
  content: unknown;
  tags?: string[];
}

/**
 * Partial mutations allowed on an existing state. Only fields present here
 * are mutable; the original `created` timestamp, `id`, `workspaceId`, and
 * `sessionId` remain immutable.
 */
export interface UpdateStateData {
  name?: string;
  description?: string;
  tags?: string[];
  content?: unknown;
}

/**
 * Options for listing states: pagination plus the archive filter.
 *
 * `includeArchived` is answered in SQL from the denormalized `isArchived`
 * column (issue #219):
 *
 * - omitted / `true` — every state, archived or not. This is the default
 *   because restoring, renaming and name-uniqueness checks all need to see
 *   archived states; only list views want them hidden.
 * - `false` — archived rows are excluded by the query itself.
 *
 * Rows whose flag is still unknown (NULL — not backfilled yet) are returned
 * either way, so a caller that filters on archive state must still treat the
 * snapshot content as authoritative for those.
 */
export interface StateListOptions extends PaginationParams {
  includeArchived?: boolean;
}

/**
 * State repository interface
 */
export interface IStateRepository extends IRepository<StateMetadata> {
  /**
   * Get states for a workspace or session
   *
   * @param workspaceId - Parent workspace ID
   * @param sessionId - Optional session ID to filter by
   * @param options - Pagination and archive-filter options
   * @returns Paginated list of state metadata
   */
  getStates(
    workspaceId: string,
    sessionId?: string,
    options?: StateListOptions
  ): Promise<PaginatedResult<StateMetadata>>;

  /**
   * Resolve one state by name or id within a workspace, in SQL.
   *
   * Use this instead of scanning `getStates` for a match: that is paginated
   * (default 25, hard cap 200), so a scan silently cannot see older states.
   * Archived rows are included.
   *
   * @param workspaceId - Workspace that owns the state
   * @param identifier - State id, or state name
   * @param options - Match tuning; see the implementation
   * @returns Matching state metadata, or null
   */
  findState(
    workspaceId: string,
    identifier: string,
    options?: { matchId?: boolean; caseSensitiveName?: boolean }
  ): Promise<StateMetadata | null>;

  /**
   * Fill in the denormalized columns for rows migrated from a pre-v16 schema.
   * Reads each affected workspace's JSONL stream once. No-op (one indexed
   * SELECT) once every row is known.
   *
   * @returns number of rows updated
   */
  backfillDerivedStateMetadata(): Promise<number>;

  /**
   * Get full state data including content
   *
   * @param id - State ID
   * @returns Full state data or null if not found
   */
  getStateData(id: string): Promise<StateData | null>;

  /**
   * Save a new state (includes full content)
   *
   * @param workspaceId - Parent workspace ID
   * @param sessionId - Parent session ID
   * @param data - State data
   * @returns ID of the created state
   */
  saveState(
    workspaceId: string,
    sessionId: string,
    data: SaveStateData
  ): Promise<string>;

  /**
   * Update an existing state's metadata or content.
   * Writes a state_updated event to the workspace JSONL and patches the
   * SQLite cache. Only fields present in `updates` are mutated.
   *
   * @param id - State ID
   * @param updates - Partial fields to mutate
   * @throws Error if the state does not exist
   */
  updateState(id: string, updates: UpdateStateData): Promise<void>;

  /**
   * Count states for a workspace or session
   *
   * @param workspaceId - Parent workspace ID
   * @param sessionId - Optional session ID to filter by
   * @returns Number of states
   */
  countStates(workspaceId: string, sessionId?: string): Promise<number>;

  /**
   * Get states by tag
   *
   * @param tag - Tag to search for
   * @param options - Pagination options
   * @returns Paginated list of states with the tag
   */
  getByTag(tag: string, options?: PaginationParams): Promise<PaginatedResult<StateMetadata>>;
}
