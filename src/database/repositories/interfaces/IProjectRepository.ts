/**
 * Location: src/database/repositories/interfaces/IProjectRepository.ts
 *
 * Project Repository Interface
 *
 * Defines project-specific operations beyond basic CRUD.
 * Projects organize tasks within a workspace boundary.
 *
 * Related Files:
 * - src/database/repositories/ProjectRepository.ts - Implementation
 * - src/database/repositories/interfaces/IRepository.ts - Base interface
 */

import { IRepository } from './IRepository';
import { PaginatedResult, PaginationParams } from '../../../types/pagination/PaginationTypes';

/**
 * Project metadata as stored in SQLite
 */
export interface ProjectMetadata {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  status: 'active' | 'completed' | 'archived';
  created: number;
  updated: number;
  metadata?: Record<string, unknown>;
}

/**
 * Data required to create a new project
 */
export interface CreateProjectData {
  name: string;
  description?: string;
  workspaceId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Data for updating an existing project
 */
export interface UpdateProjectData {
  name?: string;
  description?: string;
  status?: 'active' | 'completed' | 'archived';
  metadata?: Record<string, unknown>;
}

/**
 * Project repository interface
 */
export interface IProjectRepository extends IRepository<ProjectMetadata> {
  /**
   * Get projects for a workspace with optional pagination
   */
  getByWorkspace(workspaceId: string, options?: PaginationParams & { status?: string }): Promise<PaginatedResult<ProjectMetadata>>;

  /**
   * Get a project by name within a workspace
   */
  getByName(workspaceId: string, name: string): Promise<ProjectMetadata | null>;
}
