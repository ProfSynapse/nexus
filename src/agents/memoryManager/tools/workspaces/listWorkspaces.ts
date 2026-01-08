import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
/**
 * Location: src/agents/memoryManager/modes/workspaces/ListWorkspacesMode.ts
 * 
 * Purpose: Implements the listWorkspaces mode for the consolidated MemoryManager
 * This mode lists available workspaces with filtering and sorting options.
 * 
 * Used by: MemoryManagerAgent for workspace listing operations
 * Integrates with: WorkspaceService for accessing workspace data
 */

import { BaseTool } from '../../../baseTool';
import { 
  ListWorkspacesParameters, 
  ListWorkspacesResult
} from '../../../../database/workspace-types';
import { WorkspaceService } from '../../../../services/WorkspaceService';
import { parseWorkspaceContext } from '../../../../utils/contextUtils';

/**
 * Mode to list available workspaces with filtering and sorting
 */
export class ListWorkspacesTool extends BaseTool<ListWorkspacesParameters, ListWorkspacesResult> {
  private agent: any;
  
  /**
   * Create a new ListWorkspacesMode for the consolidated MemoryManager
   * @param agent The MemoryManagerAgent instance
   */
  constructor(agent: any) {
    super(
      'listWorkspaces',
      'List Workspaces',
      'List available workspaces with filters and sorting',
      '1.0.0'
    );
    this.agent = agent;
  }
  
  /**
   * Execute the mode to list workspaces
   * @param params Mode parameters
   * @returns Promise resolving to the result
   */
  async execute(params: ListWorkspacesParameters): Promise<ListWorkspacesResult> {
    try {
      // Get workspace service from agent
      const workspaceService = await this.agent.getWorkspaceServiceAsync();
      if (!workspaceService) {
        return {
          success: false,
          error: 'WorkspaceService not available',
          data: { workspaces: [] }
        };
      }
      
      // Get workspaces with optional filtering and sorting
      const queryParams: {
        sortBy?: 'name' | 'created' | 'lastAccessed',
        sortOrder?: 'asc' | 'desc',
        limit?: number
      } = {
        sortBy: params.sortBy as 'name' | 'created' | 'lastAccessed' | undefined,
        sortOrder: params.order as 'asc' | 'desc' | undefined,
        limit: params.limit
      };

      let workspaces;
      try {
        workspaces = await workspaceService.getWorkspaces(queryParams);
      } catch (queryError) {
        return {
          success: false,
          error: `Failed to query workspaces: ${queryError instanceof Error ? queryError.message : String(queryError)}`,
          data: { workspaces: [] }
        };
      }

      // Filter out archived workspaces unless explicitly requested
      const includeArchived = params.includeArchived ?? false;
      let filteredWorkspaces = workspaces;
      if (!includeArchived) {
        filteredWorkspaces = workspaces.filter((ws: { isArchived?: boolean }) => !ws.isArchived);
      }

      // Lean format: just name and description
      const leanWorkspaces = filteredWorkspaces.map((ws: { id: string; name: string; description?: string; rootFolder?: string; created?: number; lastAccessed?: number; isActive?: boolean }) => ({
        name: ws.name,
        description: ws.description || ''
      }));

      return {
        success: true,
        data: leanWorkspaces
      };
      
    } catch (error: any) {
      return {
        success: false,
        error: `Unexpected error: ${error.message || String(error)}`,
        data: { workspaces: [] }
      };
    }
  }
  
  /**
   * Get the parameter schema
   */
  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        includeArchived: {
          type: 'boolean',
          description: 'Include archived workspaces (default: false)'
        },
        sortBy: {
          type: 'string',
          enum: ['name', 'created', 'lastAccessed'],
          description: 'Field to sort workspaces by'
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort order (ascending or descending)'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of workspaces to return'
        }
      }
    };

    // Merge with common schema (adds sessionId, workspaceContext)
    return this.getMergedSchema(toolSchema);
  }
  
  /**
   * Get the result schema
   */
  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the operation was successful'
        },
        error: {
          type: 'string',
          description: 'Error message if operation failed'
        },
        data: {
          type: 'array',
          description: 'Array of workspaces with name and description',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Workspace name'
              },
              description: {
                type: 'string',
                description: 'Workspace description'
              }
            },
            required: ['name', 'description']
          }
        }
      },
      required: ['success']
    };
  }
}