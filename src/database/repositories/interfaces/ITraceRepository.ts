/**
 * Location: src/database/repositories/interfaces/ITraceRepository.ts
 *
 * Trace Repository Interface
 *
 * Defines trace-specific operations for managing memory traces.
 * Traces record significant events and context during work sessions.
 *
 * Related Files:
 * - src/database/repositories/TraceRepository.ts - Implementation
 * - src/types/storage/HybridStorageTypes.ts - MemoryTraceData type
 */

import { IRepository } from './IRepository';
import { MemoryTraceData } from '../../../types/storage/HybridStorageTypes';
import { PaginatedResult, PaginationParams } from '../../../types/pagination/PaginationTypes';

/**
 * Data required to add a trace
 */
export interface AddTraceData {
  content: string;
  type?: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

/**
 * Trace repository interface
 */
export interface ITraceRepository extends IRepository<MemoryTraceData> {
  /**
   * Get traces for a workspace or session
   *
   * @param workspaceId - Parent workspace ID
   * @param sessionId - Optional session ID to filter by
   * @param options - Pagination options
   * @returns Paginated list of traces
   */
  getTraces(
    workspaceId: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<MemoryTraceData>>;

  /**
   * Add a new trace
   *
   * @param workspaceId - Parent workspace ID
   * @param sessionId - Parent session ID
   * @param data - Trace data
   * @returns ID of the created trace
   */
  addTrace(
    workspaceId: string,
    sessionId: string,
    data: AddTraceData
  ): Promise<string>;

  /**
   * Search traces by content
   *
   * @param workspaceId - Workspace ID to search within
   * @param query - Search query
   * @param sessionId - Optional session ID to filter by
   * @param options - Pagination options
   * @returns Paginated list of matching traces
   */
  searchTraces(
    workspaceId: string,
    query: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<MemoryTraceData>>;

  /**
   * Get traces by type
   *
   * @param workspaceId - Parent workspace ID
   * @param type - Trace type
   * @param options - Pagination options
   * @returns Paginated list of traces of that type
   */
  getByType(
    workspaceId: string,
    type: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<MemoryTraceData>>;

  /**
   * Count traces for a workspace or session
   *
   * @param workspaceId - Parent workspace ID
   * @param sessionId - Optional session ID to filter by
   * @returns Number of traces
   */
  countTraces(workspaceId: string, sessionId?: string): Promise<number>;
}
