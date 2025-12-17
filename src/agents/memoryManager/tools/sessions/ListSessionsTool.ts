/**
 * ListSessionsMode - Lists sessions with filtering and sorting capabilities
 * Following the same pattern as ListWorkspacesMode for consistency
 */

import { BaseTool } from '../../../baseTool';
import { MemoryManagerAgent } from '../../memoryManager'
import { ListSessionsParams, SessionResult } from '../../types';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { extractContextFromParams } from '../../../../utils/contextUtils';
import { MemoryService } from "../../services/MemoryService";
import { WorkspaceService, GLOBAL_WORKSPACE_ID } from '../../../../services/WorkspaceService';
import { PaginationParams } from '../../../../types/pagination/PaginationTypes';

/**
 * Mode for listing sessions with filtering and sorting
 */
export class ListSessionsTool extends BaseTool<ListSessionsParams, SessionResult> {
  private agent: MemoryManagerAgent;

  constructor(agent: MemoryManagerAgent) {
    super(
      'listSessions',
      'List Sessions',
      'List sessions with optional filtering and sorting',
      '2.0.0'
    );
    this.agent = agent;
  }

  async execute(params: ListSessionsParams): Promise<SessionResult> {
    try {
      // Get services from agent
      const memoryService = await this.agent.getMemoryServiceAsync();
      const workspaceService = await this.agent.getWorkspaceServiceAsync();

      if (!memoryService) {
        return this.prepareResult(false, undefined, 'Memory service not available');
      }

      // Get workspace ID from context
      let workspaceId: string | undefined;
      const inheritedContext = this.getInheritedWorkspaceContext(params);
      if (inheritedContext?.workspaceId) {
        workspaceId = inheritedContext.workspaceId;
      }

      // Ensure workspaceId is defined
      const finalWorkspaceId = workspaceId || GLOBAL_WORKSPACE_ID;

      // Build pagination options from params
      const paginationOptions: PaginationParams | undefined = params.limit
        ? { page: 0, pageSize: params.limit }
        : undefined;

      // Get sessions with pagination support
      const paginatedResult = await memoryService.getSessions(finalWorkspaceId, paginationOptions);

      // Sort sessions (in-memory for now, can be moved to DB layer later)
      const sortedSessions = this.sortSessions(paginatedResult.items, params.order || 'desc');

      // Enhance session data with workspace names
      const enhancedSessions = workspaceService
        ? await this.enhanceSessionsWithWorkspaceNames(sortedSessions, workspaceService)
        : sortedSessions.map(session => ({
            ...session,
            workspaceName: 'Unknown Workspace'
          }));

      return this.prepareResult(true, {
        sessions: enhancedSessions,
        total: paginatedResult.totalItems,
        page: paginatedResult.page,
        pageSize: paginatedResult.pageSize,
        totalPages: paginatedResult.totalPages,
        hasNextPage: paginatedResult.hasNextPage,
        hasPreviousPage: paginatedResult.hasPreviousPage
      });

    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error listing sessions: ', error));
    }
  }

  /**
   * Sort sessions by the specified order (by name since we don't have timestamps)
   */
  private sortSessions(sessions: any[], order: 'asc' | 'desc'): any[] {
    return sessions.sort((a, b) => {
      const nameA = (a.name || '').toLowerCase();
      const nameB = (b.name || '').toLowerCase();
      return order === 'asc' ? nameA.localeCompare(nameB) : nameB.localeCompare(nameA);
    });
  }

  /**
   * Enhance sessions with workspace names
   */
  private async enhanceSessionsWithWorkspaceNames(sessions: any[], workspaceService: WorkspaceService): Promise<any[]> {
    const workspaceCache = new Map<string, string>();
    
    const enhanced = await Promise.all(sessions.map(async (session) => {
      let workspaceName = 'Unknown Workspace';
      
      if (!workspaceCache.has(session.workspaceId)) {
        try {
          const workspace = await workspaceService.getWorkspace(session.workspaceId);
          workspaceName = workspace?.name || 'Unknown Workspace';
          workspaceCache.set(session.workspaceId, workspaceName);
        } catch {
          workspaceCache.set(session.workspaceId, 'Unknown Workspace');
        }
      } else {
        workspaceName = workspaceCache.get(session.workspaceId)!;
      }

      return {
        ...session,
        workspaceName
      };
    }));

    return enhanced;
  }


  /**
   * Get workspace context from inherited parameters
   */
  protected getInheritedWorkspaceContext(params: ListSessionsParams): any {
    return extractContextFromParams(params);
  }

  getParameterSchema(): any {
    const customSchema = {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of sessions to return'
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort order by name'
        }
      },
      additionalProperties: false
    };
    
    return this.getMergedSchema(customSchema);
  }

  getResultSchema(): any {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the operation was successful'
        },
        data: {
          type: 'object',
          description: 'Session data with pagination'
        },
        error: {
          type: 'string',
          description: 'Error message if operation failed'
        }
      },
      required: ['success'],
      additionalProperties: false
    };
  }
}