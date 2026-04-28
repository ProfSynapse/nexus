/**
 * Location: /src/agents/memoryManager/services/WorkspaceDataFetcher.ts
 * Purpose: Fetches sessions and states data for workspaces with pagination
 *
 * This service handles fetching and filtering workspace-related data
 * including sessions and states from the memory service.
 *
 * Used by: LoadWorkspaceMode for retrieving workspace sessions and states
 * Integrates with: MemoryService for data access
 *
 * Responsibilities:
 * - Fetch workspace sessions with pagination
 * - Fetch workspace states with pagination
 */

import { PaginatedResult, PaginationParams, createEmptyPaginatedResult } from '../../../types/pagination/PaginationTypes';

/**
 * Session summary returned from fetch operations
 */
export interface SessionSummary {
  id: string;
  name: string;
  description?: string;
  created: number;
  workspaceId?: string;
}

/**
 * State summary returned from fetch operations
 */
export interface StateSummary {
  id: string;
  name: string;
  description?: string;
  sessionId?: string;
  created: number;
  tags?: string[];
  workspaceId?: string;
}

/**
 * Service for fetching workspace sessions and states
 * Implements Single Responsibility Principle - only handles data fetching
 */
export class WorkspaceDataFetcher {
  private static isMemoryService(
    memoryService: unknown
  ): memoryService is {
    getSessions(workspaceId: string, options?: PaginationParams): Promise<PaginatedResult<{ id: string; name: string; description?: string; startTime?: number; created?: number; workspaceId?: string }>>;
    getStates(workspaceId: string, sessionId?: string, options?: PaginationParams): Promise<PaginatedResult<{
      id: string;
      name?: string;
      description?: string;
      sessionId?: string;
      tags?: string[];
      created?: number;
      timestamp?: number;
      workspaceId?: string;
      state?: {
        description?: string;
        sessionId?: string;
        workspaceId?: string;
        metadata?: { tags?: string[] };
        state?: {
          metadata?: { tags?: string[] };
        };
      };
    }>>;
  } {
    return !!memoryService
      && typeof memoryService === 'object'
      && 'getSessions' in memoryService
      && typeof memoryService.getSessions === 'function'
      && 'getStates' in memoryService
      && typeof memoryService.getStates === 'function';
  }

  /**
   * Fetch sessions for a workspace with pagination
   * @param workspaceId The workspace ID
   * @param memoryService The memory service instance
   * @param options Optional pagination parameters
   * @returns Paginated result of session summaries
   */
  async fetchWorkspaceSessions(
    workspaceId: string,
    memoryService: unknown,
    options?: PaginationParams
  ): Promise<PaginatedResult<SessionSummary>> {
    try {
      if (!WorkspaceDataFetcher.isMemoryService(memoryService)) {
        return createEmptyPaginatedResult<SessionSummary>(0, options?.pageSize ?? 10);
      }

      // Validate workspace ID
      if (!workspaceId || workspaceId === 'unknown') {
        return createEmptyPaginatedResult<SessionSummary>(0, options?.pageSize ?? 10);
      }

      // MemoryService delegates to workspace-scoped storage queries.
      const sessionsResult = await memoryService.getSessions(workspaceId, options);
      const sessions = sessionsResult.items || [];

      // Map to session summaries
      const sessionSummaries = sessions
        .filter((session: { id: string }) => session.id !== '_workspace')
        .map((session: { id: string; name?: string; description?: string; startTime?: number; created?: number; workspaceId?: string }) => ({
          id: session.id,
          name: session.name || 'Untitled Session',
          description: session.description,
          created: session.startTime ?? session.created ?? 0,
          workspaceId: session.workspaceId
        }));

      return {
        items: sessionSummaries,
        page: sessionsResult.page,
        pageSize: sessionsResult.pageSize,
        totalItems: sessionsResult.totalItems,
        totalPages: sessionsResult.totalPages,
        hasNextPage: sessionsResult.hasNextPage,
        hasPreviousPage: sessionsResult.hasPreviousPage
      };

    } catch (error) {
      console.error('[WorkspaceDataFetcher] Failed to fetch workspace sessions:', error);
      return createEmptyPaginatedResult<SessionSummary>(0, options?.pageSize ?? 10);
    }
  }

  /**
   * Fetch states for a workspace with pagination
   * @param workspaceId The workspace ID
   * @param memoryService The memory service instance
   * @param options Optional pagination parameters
   * @returns Paginated result of state summaries
   */
  async fetchWorkspaceStates(
    workspaceId: string,
    memoryService: unknown,
    options?: PaginationParams
  ): Promise<PaginatedResult<StateSummary>> {
    try {
      if (!WorkspaceDataFetcher.isMemoryService(memoryService)) {
        return createEmptyPaginatedResult<StateSummary>(0, options?.pageSize ?? 10);
      }

      // Validate workspace ID
      if (!workspaceId || workspaceId === 'unknown') {
        return createEmptyPaginatedResult<StateSummary>(0, options?.pageSize ?? 10);
      }

      // getStates returns PaginatedResult - pass pagination options
      const statesResult = await memoryService.getStates(workspaceId, undefined, options);

      // Extract items from paginated result. MemoryService delegates to
      // workspace-scoped storage queries, so an additional workspaceId filter
      // here would reject adapter metadata rows that intentionally omit nested
      // state.workspaceId content.
      const states = statesResult.items;

      // Map to state summaries
      const stateSummaries = states.map((state: {
        id: string;
        name?: string;
        description?: string;
        sessionId?: string;
        tags?: string[];
        isArchived?: boolean;
        created?: number;
        timestamp?: number;
        workspaceId?: string;
        state?: {
          description?: string;
          sessionId?: string;
          workspaceId?: string;
          metadata?: { tags?: string[] };
          state?: {
            metadata?: { tags?: string[] };
          };
        }
      }) => ({
        id: state.id,
        name: state.name || 'Untitled State',
        description: state.description || state.state?.description,
        sessionId: state.sessionId || state.state?.sessionId,
        created: state.created ?? state.timestamp ?? 0,
        tags: state.tags || state.state?.state?.metadata?.tags || state.state?.metadata?.tags || [],
        workspaceId: state.state?.workspaceId || state.workspaceId // Include for validation
      }));

      // Return with pagination metadata from the original result
      return {
        items: stateSummaries,
        page: statesResult.page,
        pageSize: statesResult.pageSize,
        totalItems: statesResult.totalItems,
        totalPages: statesResult.totalPages,
        hasNextPage: statesResult.hasNextPage,
        hasPreviousPage: statesResult.hasPreviousPage
      };

    } catch (error) {
      console.error('[WorkspaceDataFetcher] Failed to fetch workspace states:', error);
      return createEmptyPaginatedResult<StateSummary>(0, options?.pageSize ?? 10);
    }
  }
}
