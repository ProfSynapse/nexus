/**
 * Location: src/agents/taskManager/tools/projects/listProjects.ts
 * Purpose: Tool to list projects in a workspace with optional filtering.
 *
 * Used by: TaskManagerAgent (via lazy tool registration)
 * Dependencies: TaskService
 */

import { BaseTool } from '../../../baseTool';
import { TaskService } from '../../services/TaskService';
import { ListProjectsParameters, ListProjectsResult } from '../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { createErrorMessage } from '../../../../utils/errorUtils';

export class ListProjectsTool extends BaseTool<ListProjectsParameters, ListProjectsResult> {
  constructor(private taskService: TaskService) {
    super(
      'listProjects',
      'List Projects',
      'List projects in a workspace with optional status filter',
      '1.0.0'
    );
  }

  async execute(params: ListProjectsParameters): Promise<ListProjectsResult> {
    try {
      if (!params.workspaceId) {
        return this.prepareResult(false, undefined, 'workspaceId is required');
      }

      const result = await this.taskService.listProjects(params.workspaceId, {
        status: params.status,
        page: params.page,
        pageSize: params.pageSize
      });

      return {
        success: true,
        projects: result.items,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          totalItems: result.totalItems,
          totalPages: result.totalPages,
          hasNextPage: result.hasNextPage
        }
      };
    } catch (error) {
      return { success: false, error: createErrorMessage('Failed to list projects: ', error) };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID (REQUIRED)' },
        status: { type: 'string', enum: ['active', 'completed', 'archived'], description: 'Filter by project status' },
        page: { type: 'number', description: 'Page number (0-indexed, default: 0)', minimum: 0 },
        pageSize: { type: 'number', description: 'Items per page (default: 20)', minimum: 1, maximum: 100 }
      },
      required: ['workspaceId']
    });
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        projects: { type: 'array', items: { type: 'object' }, description: 'List of projects' },
        pagination: { type: 'object', description: 'Pagination metadata' },
        error: { type: 'string' }
      }
    };
  }
}
