import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
/**
 * ListStatesMode - Lists states with filtering and sorting capabilities
 * Following the same pattern as ListWorkspacesMode for consistency
 */

import { BaseTool } from '../../../baseTool';
import { MemoryManagerAgent } from '../../memoryManager';
import { verbs } from '../../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { ListStatesParams, StateResult } from '../../types';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { WorkspaceService, GLOBAL_WORKSPACE_ID } from '../../../../services/WorkspaceService';

interface StateLike {
  id?: string;
  name: string;
  description?: string;
  sessionId?: string;
  tags?: string[];
  timestamp?: number;
  created?: number;
  workspaceId?: string;
  state?: {
    sessionId?: string;
    workspaceId?: string;
    context?: {
      activeFiles?: string[];
      activeTask?: string;
    };
    state?: {
      metadata?: {
        tags?: string[];
        isArchived?: boolean;
      };
    };
  };
}

interface EnhancedStateLike extends StateLike {
  workspaceName: string;
  created: number;
  context?: {
    files: string[];
    traceCount: number;
    tags: string[];
    summary: string;
  };
}

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

      if (!memoryService) {
        return this.prepareResult(false, undefined, 'Memory service not available');
      }

      const workspaceService = await this.agent.getWorkspaceServiceAsync();
      if (!workspaceService) {
        return this.prepareResult(false, undefined, 'Workspace service not available');
      }

      const workspaceResult = await this.resolveWorkspaceId(params, workspaceService);
      if (!workspaceResult.success || !workspaceResult.workspaceId) {
        return this.prepareResult(false, undefined, workspaceResult.error);
      }

      // Prepare pagination options for DB-level pagination
      // Use pageSize if provided, otherwise fall back to limit for backward compatibility
      const pageSize = params.pageSize || params.limit;
      const paginationOptions = {
        page: params.page ?? 0,
        pageSize: pageSize
      };

      // Get states with true DB-level pagination across the workspace
      const statesResult = await memoryService.getStates(
        workspaceResult.workspaceId,
        undefined,
        paginationOptions
      );

      // Extract items from PaginatedResult
      let processedStates: StateLike[] = statesResult.items as unknown as StateLike[];

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
      const tags = params.tags ?? [];
      if (tags.length > 0) {
        processedStates = processedStates.filter(state => {
          const stateData = state.state as unknown as Record<string, unknown> | undefined;
          const nestedState = stateData?.state as Record<string, unknown> | undefined;
          const metadata = nestedState?.metadata as Record<string, unknown> | undefined;
          const stateTags = state.tags || (metadata?.tags as string[]) || [];
          return tags.some(tag => stateTags.includes(tag));
        });
      }

      // Sort states (in-memory sorting for now - TODO: move to DB level)
      const sortedStates = this.sortStates(processedStates, params.order || 'desc');

      const listedStates = sortedStates.map(state => ({
        id: state.id,
        name: state.name,
        description: state.description || state.state?.context?.activeTask || 'No description',
        sessionId: state.sessionId || state.state?.sessionId,
        workspaceId: state.workspaceId || state.state?.workspaceId,
        created: state.created ?? state.timestamp ?? 0,
        tags: state.tags || state.state?.state?.metadata?.tags || []
      }));

      return this.prepareResult(true, listedStates);

    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error listing states: ', error));
    }
  }

  /**
   * Sort states by creation date
   */
  private sortStates(states: StateLike[], order: 'asc' | 'desc'): StateLike[] {
    return states.sort((a, b) => {
      const timeA = a.timestamp || a.created || 0;
      const timeB = b.timestamp || b.created || 0;
      return order === 'asc' ? timeA - timeB : timeB - timeA;
    });
  }

  private async resolveWorkspaceId(
    params: ListStatesParams,
    workspaceService: WorkspaceService
  ): Promise<{ success: boolean; workspaceId?: string; error?: string }> {
    const inheritedContext = super.getInheritedWorkspaceContext(params);
    const workspaceIdentifier = inheritedContext?.workspaceId || GLOBAL_WORKSPACE_ID;
    const workspace = await workspaceService.getWorkspaceByNameOrId(workspaceIdentifier);
    if (!workspace) {
      return {
        success: false,
        error: `Workspace not found: ${workspaceIdentifier}. Workspace names are accepted, but the name must match an existing workspace.`
      };
    }

    return { success: true, workspaceId: workspace.id };
  }

  /**
   * Enhance states with workspace names and context
   */
  private async enhanceStatesWithContext(
    states: StateLike[],
    workspaceService: WorkspaceService,
    includeContext?: boolean
  ): Promise<EnhancedStateLike[]> {
    const workspaceCache = new Map<string, string>();
    
    return await Promise.all(states.map(async (state) => {
      const stateWorkspaceId = state.workspaceId || 'unknown';
      let workspaceName = workspaceCache.get(stateWorkspaceId) ?? 'Unknown Workspace';

      if (!workspaceCache.has(stateWorkspaceId)) {
        try {
          const workspace = await workspaceService.getWorkspace(stateWorkspaceId);
          workspaceName = workspace?.name || 'Unknown Workspace';
          workspaceCache.set(stateWorkspaceId, workspaceName);
        } catch {
          workspaceCache.set(stateWorkspaceId, 'Unknown Workspace');
          workspaceName = 'Unknown Workspace';
        }
      }

      const enhanced: EnhancedStateLike = {
        ...state,
        workspaceName,
        created: state.created ?? state.timestamp ?? 0
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


  getStatusLabel(_params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const v = verbs('Listing states', 'Listed states', 'Failed to list states');
    return v[tense];
  }

  getParameterSchema(): JSONSchema {
    const toolSchema = {
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

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): JSONSchema {
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
