/**
 * ListStatesMode - Lists states with filtering and sorting capabilities
 * Following the same pattern as ListWorkspacesMode for consistency
 */

import { BaseTool } from '../../../baseTool';
import { MemoryManagerAgent } from '../../memoryManager'
import { ListStatesParams, StateResult } from '../../types';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { extractContextFromParams } from '../../../../utils/contextUtils';
import { MemoryService } from "../../services/MemoryService";
import { WorkspaceService, GLOBAL_WORKSPACE_ID } from '../../../../services/WorkspaceService';

/**
 * Mode for listing states with filtering and sorting
 */
export class ListStatesTool extends BaseTool<ListStatesParams, StateResult> {
  private agent: MemoryManagerAgent;

  constructor(agent: MemoryManagerAgent) {
    super(
      'listStates',
      'List States',
      'List states with optional filtering and sorting',
      '2.0.0'
    );
    this.agent = agent;
  }

  async execute(params: ListStatesParams): Promise<StateResult> {
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

      // Prepare pagination options for DB-level pagination
      // Use pageSize if provided, otherwise fall back to limit for backward compatibility
      const pageSize = params.pageSize || params.limit;
      const paginationOptions = {
        page: params.page ?? 0,
        pageSize: pageSize
      };

      // Get states with true DB-level pagination (use '_workspace' as sessionId)
      const statesResult = await memoryService.getStates(
        workspaceId || GLOBAL_WORKSPACE_ID,
        '_workspace',
        paginationOptions
      );

      // Extract items from PaginatedResult
      let processedStates = statesResult.items;

      // Filter out archived states by default (unless includeArchived is true)
      if (!params.includeArchived) {
        processedStates = processedStates.filter(state => {
          const stateData = state.state as unknown as Record<string, unknown> | undefined;
          const nestedState = stateData?.state as Record<string, unknown> | undefined;
          const metadata = nestedState?.metadata as Record<string, unknown> | undefined;
          return !metadata?.isArchived;
        });
      }

      // Filter by tags if provided (tags aren't in DB, so must filter in-memory)
      // Note: This happens AFTER pagination, so may return fewer results than pageSize
      if (params.tags && params.tags.length > 0) {
        processedStates = processedStates.filter(state => {
          const stateData = state.state as unknown as Record<string, unknown> | undefined;
          const nestedState = stateData?.state as Record<string, unknown> | undefined;
          const metadata = nestedState?.metadata as Record<string, unknown> | undefined;
          const stateTags = (metadata?.tags as string[]) || [];
          return params.tags!.some(tag => stateTags.includes(tag));
        });
      }

      // Sort states (in-memory sorting for now - TODO: move to DB level)
      const sortedStates = this.sortStates(processedStates, params.order || 'desc');

      // Simplify state data to just name and description
      const simplifiedStates = sortedStates.map(state => ({
        name: state.name,
        description: state.description || state.state?.context?.activeTask || 'No description'
      }));

      return this.prepareResult(true, simplifiedStates);

    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error listing states: ', error));
    }
  }

  /**
   * Sort states by creation date
   */
  private sortStates(states: any[], order: 'asc' | 'desc'): any[] {
    return states.sort((a, b) => {
      const timeA = a.timestamp || a.created || 0;
      const timeB = b.timestamp || b.created || 0;
      return order === 'asc' ? timeA - timeB : timeB - timeA;
    });
  }

  /**
   * Enhance states with workspace names and context
   */
  private async enhanceStatesWithContext(states: any[], workspaceService: WorkspaceService, includeContext?: boolean): Promise<any[]> {
    const workspaceCache = new Map<string, string>();
    
    return await Promise.all(states.map(async (state) => {
      let workspaceName = 'Unknown Workspace';
      
      if (!workspaceCache.has(state.workspaceId)) {
        try {
          const workspace = await workspaceService.getWorkspace(state.workspaceId);
          workspaceName = workspace?.name || 'Unknown Workspace';
          workspaceCache.set(state.workspaceId, workspaceName);
        } catch {
          workspaceCache.set(state.workspaceId, 'Unknown Workspace');
        }
      } else {
        workspaceName = workspaceCache.get(state.workspaceId)!;
      }

      const enhanced: any = {
        ...state,
        workspaceName,
        created: state.created || state.timestamp
      };

      if (includeContext && state.state?.context) {
        enhanced.context = {
          files: state.state.context.activeFiles || [],
          traceCount: 0, // Could be enhanced to count related traces
          tags: state.state?.state?.metadata?.tags || [],
          summary: state.state.context.activeTask || 'No active task recorded'
        };
      }

      return enhanced;
    }));
  }


  /**
   * Get workspace context from inherited parameters
   */
  protected getInheritedWorkspaceContext(params: ListStatesParams): any {
    return extractContextFromParams(params);
  }

  getParameterSchema(): any {
    const customSchema = {
      type: 'object',
      properties: {
        includeArchived: {
          type: 'boolean',
          description: 'Include archived states (default: false)'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags'
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (0-indexed, default: 0)',
          minimum: 0
        },
        pageSize: {
          type: 'number',
          description: 'Number of items per page (default: all items if not specified)',
          minimum: 1
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort order by creation date (default: desc)'
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
          description: 'State data with pagination'
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