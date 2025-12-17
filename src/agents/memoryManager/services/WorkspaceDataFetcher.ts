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
 * - Fetch workspace sessions with defensive validation and pagination
 * - Fetch workspace states with defensive validation and pagination
 * - Filter data to ensure workspace isolation
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
  sessionId: string;
  created: number;
  tags?: string[];
  workspaceId?: string;
}

/**
 * Service for fetching workspace sessions and states
 * Implements Single Responsibility Principle - only handles data fetching
 */
export class WorkspaceDataFetcher {
  /**
   * Fetch sessions for a workspace with defensive filtering and pagination
   * @param workspaceId The workspace ID
   * @param memoryService The memory service instance
   * @param options Optional pagination parameters
   * @returns Paginated result of session summaries
   */
  async fetchWorkspaceSessions(
    workspaceId: string,
    memoryService: any,
    options?: PaginationParams
  ): Promise<PaginatedResult<SessionSummary>> {
    try {
      if (!memoryService) {
        return createEmptyPaginatedResult<SessionSummary>(0, options?.pageSize ?? 10);
      }

      // Validate workspace ID
      if (!workspaceId || workspaceId === 'unknown') {
        return createEmptyPaginatedResult<SessionSummary>(0, options?.pageSize ?? 10);
      }

      // Note: getSessions currently returns an array, not PaginatedResult
      // This is a limitation we'll work with for now
      const sessions = await memoryService.getSessions(workspaceId);

      // Defensive validation: ensure all sessions belong to workspace
      const validSessions = sessions.filter((session: any) =>
        session.workspaceId === workspaceId
      );

      if (validSessions.length !== sessions.length) {
        console.error(
          `[WorkspaceDataFetcher] Database filtering failed! Retrieved ${sessions.length} sessions, ` +
          `only ${validSessions.length} belong to workspace ${workspaceId}`
        );
      }

      // Map to session summaries
      const sessionSummaries = validSessions.map((session: any) => ({
        id: session.id,
        name: session.name,
        description: session.description,
        created: session.startTime,
        workspaceId: session.workspaceId // Include for validation
      }));

      // Apply manual pagination since getSessions doesn't support it yet
      const page = options?.page ?? 0;
      const pageSize = options?.pageSize ?? sessionSummaries.length;
      const start = page * pageSize;
      const end = start + pageSize;
      const paginatedItems = sessionSummaries.slice(start, end);
      const totalPages = Math.ceil(sessionSummaries.length / pageSize);

      return {
        items: paginatedItems,
        page,
        pageSize,
        totalItems: sessionSummaries.length,
        totalPages,
        hasNextPage: page < totalPages - 1,
        hasPreviousPage: page > 0
      };

    } catch (error) {
      console.error('[WorkspaceDataFetcher] Failed to fetch workspace sessions:', error);
      return createEmptyPaginatedResult<SessionSummary>(0, options?.pageSize ?? 10);
    }
  }

  /**
   * Fetch states for a workspace with defensive filtering and pagination
   * @param workspaceId The workspace ID
   * @param memoryService The memory service instance
   * @param options Optional pagination parameters
   * @returns Paginated result of state summaries
   */
  async fetchWorkspaceStates(
    workspaceId: string,
    memoryService: any,
    options?: PaginationParams
  ): Promise<PaginatedResult<StateSummary>> {
    try {
      if (!memoryService) {
        return createEmptyPaginatedResult<StateSummary>(0, options?.pageSize ?? 10);
      }

      // Validate workspace ID
      if (!workspaceId || workspaceId === 'unknown') {
        return createEmptyPaginatedResult<StateSummary>(0, options?.pageSize ?? 10);
      }

      // getStates returns PaginatedResult - pass pagination options
      const statesResult = await memoryService.getStates(workspaceId, undefined, options);

      // Extract items from paginated result
      const states = statesResult.items;

      // Defensive validation: ensure all states belong to workspace
      const validStates = states.filter((state: any) =>
        state.state?.workspaceId === workspaceId || state.workspaceId === workspaceId
      );

      if (validStates.length !== states.length) {
        console.error(
          `[WorkspaceDataFetcher] Filtered ${states.length - validStates.length} ` +
          `cross-workspace states`
        );
      }

      // Map to state summaries
      const stateSummaries = validStates.map((state: any) => ({
        id: state.id,
        name: state.name,
        description: state.description || state.state?.description,
        sessionId: state.sessionId || state.state?.sessionId,
        created: state.created || state.timestamp,
        tags: state.state?.metadata?.tags || [],
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
