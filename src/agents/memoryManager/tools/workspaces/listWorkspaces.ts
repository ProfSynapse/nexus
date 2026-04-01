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
import type { MemoryManagerAgent } from '../../memoryManager';
import { 
  ListWorkspacesParameters, 
  ListWorkspacesResult
} from '../../../../database/workspace-types';

/**
 * Mode to list available workspaces with filtering and sorting
 */
export class ListWorkspacesTool extends BaseTool<ListWorkspacesParameters, ListWorkspacesResult> {
  private agent: MemoryManagerAgent;
  
  /**
   * Create a new ListWorkspacesMode for the consolidated MemoryManager
   * @param agent The MemoryManagerAgent instance
   */
  constructor(agent: MemoryManagerAgent) {
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
        sortBy: params.sortBy,
        sortOrder: params.order,
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

      // Preserve the result contract while tolerating partially populated workspace rows.
      const leanWorkspaces = filteredWorkspaces.map((ws: { id?: string; name?: string; description?: string; rootFolder?: string; created?: number; lastAccessed?: number; childCount?: number; isActive?: boolean }) => ({
        id: ws.id || 'unknown',
        name: ws.name || 'Untitled Workspace',
        description: ws.description,
        rootFolder: ws.rootFolder || '',
        lastAccessed: ws.lastAccessed ?? ws.created ?? 0,
        childCount: ws.childCount ?? 0
      }));

      return {
        success: true,
        data: { workspaces: leanWorkspaces }
      };
      
    } catch (error: unknown) {
      return {
        success: false,
        error: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
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
