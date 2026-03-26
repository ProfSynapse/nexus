import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
/**
 * ListStatesMode - Lists states with filtering and sorting capabilities
 * Following the same pattern as ListWorkspacesMode for consistency
 */

import { BaseTool } from '../../../baseTool';
import { MemoryManagerAgent } from '../../memoryManager'
import { ListStatesParams, StateResult } from '../../types';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { extractContextFromParams } from '../../../../utils/contextUtils';
import { GLOBAL_WORKSPACE_ID } from '../../../../services/WorkspaceService';
import type { WorkspaceState } from '../../../../database/types/session/SessionTypes';

interface StateMetadataLike {
  isArchived?: boolean;
  tags?: string[];
}

interface LegacyStateShape {
  metadata?: StateMetadataLike;
}

interface StateContextLike {
  activeTask?: string;
}

interface ListStatesItem extends Omit<WorkspaceState, 'state'> {
  created?: number;
  timestamp?: number;
  state?: LegacyStateShape & {
    context?: StateContextLike;
  };
}

interface ListStatesResultItem {
  name: string;
  description: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getWorkspaceIdFromContext(context: unknown): string | undefined {
  if (!isRecord(context)) {
    return undefined;
  }

  return typeof context.workspaceId === 'string' && context.workspaceId.length > 0
    ? context.workspaceId
    : undefined;
}

function getStateTags(state: ListStatesItem): string[] {
  const tags = state.state?.metadata?.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
}

function isArchivedState(state: ListStatesItem): boolean {
  return Boolean(state.state?.metadata?.isArchived);
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

      // Get workspace ID from context
      const workspaceId = getWorkspaceIdFromContext(this.getInheritedWorkspaceContext(params));

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
      let processedStates: ListStatesItem[] = statesResult.items;

      // Filter out archived states by default (unless includeArchived is true)
      if (!params.includeArchived) {
        processedStates = processedStates.filter(state => !isArchivedState(state));
      }

      // Filter by tags if provided (tags aren't in DB, so must filter in-memory)
      // Note: This happens AFTER pagination, so may return fewer results than pageSize
      if (params.tags && params.tags.length > 0) {
        processedStates = processedStates.filter(state => {
          const stateTags = getStateTags(state);
          return params.tags.some(tag => stateTags.includes(tag));
        });
      }

      // Sort states (in-memory sorting for now - TODO: move to DB level)
      const sortedStates = this.sortStates(processedStates, params.order || 'desc');

      // Simplify state data to just name and description
      const simplifiedStates: ListStatesResultItem[] = sortedStates.map(state => ({
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
  private sortStates(states: ListStatesItem[], order: 'asc' | 'desc'): ListStatesItem[] {
    return states.sort((a, b) => {
      const timeA = a.timestamp || a.created || 0;
      const timeB = b.timestamp || b.created || 0;
      return order === 'asc' ? timeA - timeB : timeB - timeA;
    });
  }


  /**
   * Get workspace context from inherited parameters
   */
  protected getInheritedWorkspaceContext(params: ListStatesParams): unknown {
    return extractContextFromParams(params);
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
