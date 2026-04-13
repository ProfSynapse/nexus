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
import { ToolStatusTense } from '../../../interfaces/ITool';
import { verbs } from '../../../utils/toolStatusLabels';

export class ListProjectsTool extends BaseTool<ListProjectsParameters, ListProjectsResult> {
  constructor(private taskService: TaskService) {
    super(
      'listProjects',
      'List Projects',
      'List projects in a workspace with optional status filter (active/completed/archived). Returns paginated project objects with id, name, description, status, and timestamps. Use to discover projectIds for task operations.',
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
        workspaceId: { type: 'string', description: 'Workspace ID (REQUIRED — from loadWorkspace or createWorkspace)' },
        status: { type: 'string', enum: ['active', 'completed', 'archived'], description: 'Filter by project status' },
        page: { type: 'number', description: 'Page number (0-indexed, default: 0)', minimum: 0 },
        pageSize: { type: 'number', description: 'Items per page (default: 20)', minimum: 1, maximum: 100 }
      },
      required: ['workspaceId']
    });
  }

  getStatusLabel(_params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const v = verbs('Listing projects', 'Listed projects', 'Failed to list projects');
    return v[tense];
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        projects: {
          type: 'array',
          description: 'List of project objects',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Project ID (use as projectId in task operations)' },
              workspaceId: { type: 'string', description: 'Parent workspace ID' },
              name: { type: 'string', description: 'Project name' },
              description: { type: 'string', description: 'Project description' },
              status: { type: 'string', enum: ['active', 'completed', 'archived'], description: 'Project status' },
              created: { type: 'number', description: 'Creation timestamp (ms since epoch)' },
              updated: { type: 'number', description: 'Last update timestamp (ms since epoch)' },
              metadata: { type: 'object', description: 'Custom metadata key-value pairs' }
            }
          }
        },
        pagination: {
          type: 'object',
          description: 'Pagination metadata',
          properties: {
            page: { type: 'number', description: 'Current page number (0-indexed)' },
            pageSize: { type: 'number', description: 'Items per page' },
            totalItems: { type: 'number', description: 'Total number of matching projects' },
            totalPages: { type: 'number', description: 'Total number of pages' },
            hasNextPage: { type: 'boolean', description: 'Whether more pages are available' }
          }
        },
        error: { type: 'string' }
      }
    };
  }
}
