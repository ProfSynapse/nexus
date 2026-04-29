/**
 * Location: src/database/repositories/interfaces/ISessionRepository.ts
 *
 * Session Repository Interface
 *
 * Defines session-specific operations for managing work sessions within workspaces.
 * Sessions represent periods of focused work and contain states and traces.
 *
 * Related Files:
 * - src/database/repositories/SessionRepository.ts - Implementation
 * - src/types/storage/HybridStorageTypes.ts - SessionMetadata type
 */

import { IRepository } from './IRepository';
import { SessionMetadata } from '../../../types/storage/HybridStorageTypes';
import { PaginatedResult, PaginationParams } from '../../../types/pagination/PaginationTypes';

/**
 * Data required to create a new session
 */
export interface CreateSessionData {
  id?: string;
  name: string;
  description?: string;
  startTime?: number;
  isActive?: boolean;
}

/**
 * Data for updating an existing session
 */
export interface UpdateSessionData {
  name?: string;
  description?: string;
  endTime?: number;
  isActive?: boolean;
  workspaceId?: string;
}

/**
 * Session repository interface
 */
export interface ISessionRepository extends IRepository<SessionMetadata> {
  /**
   * Get all sessions for a workspace
   *
   * @param workspaceId - Parent workspace ID
   * @param options - Pagination options
   * @returns Paginated list of sessions
   */
  getByWorkspaceId(
    workspaceId: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<SessionMetadata>>;

  /**
   * Get the currently active session for a workspace
   *
   * @param workspaceId - Parent workspace ID
   * @returns Active session or null if none active
   */
  getActiveSession(workspaceId: string): Promise<SessionMetadata | null>;

  /**
   * End a session by setting its endTime and marking it inactive
   *
   * @param id - Session ID
   */
  endSession(id: string): Promise<void>;

  /**
   * Count sessions for a workspace
   *
   * @param workspaceId - Parent workspace ID
   * @returns Number of sessions
   */
  countByWorkspace(workspaceId: string): Promise<number>;

  /**
   * Move a session and its dependent state/trace rows to another workspace.
   *
   * @param id - Session ID
   * @param workspaceId - Target workspace ID
   */
  moveToWorkspace(id: string, workspaceId: string): Promise<void>;
}
