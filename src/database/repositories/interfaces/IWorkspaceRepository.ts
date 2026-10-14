/**
 * Location: src/database/repositories/interfaces/IWorkspaceRepository.ts
 *
 * Workspace Repository Interface
 *
 * Defines workspace-specific operations beyond basic CRUD.
 * Workspaces organize sessions, states, and traces into logical boundaries.
 *
 * Related Files:
 * - src/database/repositories/WorkspaceRepository.ts - Implementation
 * - src/types/storage/HybridStorageTypes.ts - WorkspaceMetadata type
 */

import { IRepository } from './IRepository';
import { WorkspaceMetadata, WorkspaceContext } from '../../../types/storage/HybridStorageTypes';
import { PaginatedResult } from '../../../types/pagination/PaginationTypes';
import { QueryOptions } from '../../interfaces/IStorageAdapter';

/**
 * Data required to create a new workspace
 */
export interface CreateWorkspaceData {
  /** Optional custom ID (e.g., 'default' for the default workspace) */
  id?: string;
  name: string;
  description?: string;
  rootFolder: string;
  created?: number;
  isActive?: boolean;
  isArchived?: boolean;
  dedicatedAgentId?: string;
  /** Workspace context (purpose, workflows, keyFiles, etc.) */
  context?: WorkspaceContext;
}

/**
 * Data for updating an existing workspace
 */
export interface UpdateWorkspaceData {
  name?: string;
  description?: string;
  rootFolder?: string;
  lastAccessed?: number;
  isActive?: boolean;
  isArchived?: boolean;
  dedicatedAgentId?: string;
  /** Workspace context (purpose, workflows, keyFiles, etc.) */
  context?: WorkspaceContext;
}

/**
 * Workspace repository interface
 */
export interface IWorkspaceRepository extends IRepository<WorkspaceMetadata> {
  /**
   * Get all workspaces with optional filtering and sorting
   *
   * @param options - Query options (pagination, sorting, filtering)
   * @returns Paginated list of workspaces
   */
  getWorkspaces(options?: QueryOptions): Promise<PaginatedResult<WorkspaceMetadata>>;

  /**
   * Update the last accessed timestamp for a workspace
   *
   * @param id - Workspace ID
   */
  updateLastAccessed(id: string): Promise<void>;

  /**
   * Search workspaces by name or description
   *
   * @param query - Search query
   * @returns Array of matching workspaces
   */
  search(query: string): Promise<WorkspaceMetadata[]>;
}

/**
 * `create` was asked for a workspace whose id or name is already taken.
 *
 * Thrown BEFORE the `workspace_created` event is appended, so a rejected create
 * leaves nothing in the event store. The message keeps SQLite's
 * `UNIQUE constraint failed: workspaces.<column>` wording for callers that
 * still match on it.
 */
export class WorkspaceConflictError extends Error {
  constructor(
    readonly column: 'id' | 'name',
    readonly existingId: string,
    readonly requestedName: string
  ) {
    super(
      `Workspace ${column === 'id' ? `id "${existingId}"` : `name "${requestedName}"`} already exists `
      + `(UNIQUE constraint failed: workspaces.${column})`
    );
    this.name = 'WorkspaceConflictError';
  }
}
