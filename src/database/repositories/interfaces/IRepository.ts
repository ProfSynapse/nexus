/**
 * Location: src/database/repositories/interfaces/IRepository.ts
 *
 * Base Repository Interface
 *
 * Defines the standard CRUD operations that all repositories must implement.
 * This interface ensures consistency across all entity repositories.
 *
 * Design Principles:
 * - Generic type T for the entity being managed
 * - Standard CRUD operations (Create, Read, Update, Delete)
 * - Pagination support for list operations
 * - Count operations for statistics
 *
 * Related Files:
 * - src/database/repositories/base/BaseRepository.ts - Base implementation
 * - src/database/repositories/interfaces/I*Repository.ts - Entity-specific interfaces
 */

import { PaginatedResult, PaginationParams } from '../../../types/pagination/PaginationTypes';

/**
 * Base repository interface for CRUD operations
 *
 * @template T - The entity type this repository manages
 */
export interface IRepository<T> {
  /**
   * Get a single entity by ID
   *
   * @param id - Entity ID
   * @returns Entity instance or null if not found
   */
  getById(id: string): Promise<T | null>;

  /**
   * Get all entities with optional pagination
   *
   * @param options - Pagination options
   * @returns Paginated list of entities
   */
  getAll(options?: PaginationParams): Promise<PaginatedResult<T>>;

  /**
   * Create a new entity
   *
   * @param data - Entity data
   * @returns ID of the created entity
   */
  create(data: any): Promise<string>;

  /**
   * Update an existing entity
   *
   * @param id - Entity ID
   * @param data - Partial entity data to update
   */
  update(id: string, data: any): Promise<void>;

  /**
   * Delete an entity
   *
   * @param id - Entity ID
   */
  delete(id: string): Promise<void>;

  /**
   * Count entities with optional criteria
   *
   * @param criteria - Optional filter criteria
   * @returns Number of entities matching criteria
   */
  count(criteria?: Record<string, unknown>): Promise<number>;
}
