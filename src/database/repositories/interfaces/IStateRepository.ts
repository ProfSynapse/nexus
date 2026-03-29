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
 * State repository interface
 */
export interface IStateRepository extends IRepository<StateMetadata> {
  /**
   * Get states for a workspace or session
   *
   * @param workspaceId - Parent workspace ID
   * @param sessionId - Optional session ID to filter by
   * @param options - Pagination options
   * @returns Paginated list of state metadata
   */
  getStates(
    workspaceId: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<StateMetadata>>;

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
