/**
 * Location: src/agents/taskManager/tools/tasks/listTasks.ts
 * Purpose: Tool to list tasks in a project with filters for status, priority, assignee.
 *
 * Used by: TaskManagerAgent (via lazy tool registration)
 * Dependencies: TaskService
 */

import { BaseTool } from '../../../baseTool';
import { TaskService } from '../../services/TaskService';
import { ListTasksParameters, ListTasksResult } from '../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { createErrorMessage } from '../../../../utils/errorUtils';

export class ListTasksTool extends BaseTool<ListTasksParameters, ListTasksResult> {
  constructor(private taskService: TaskService) {
    super(
      'listTasks',
      'List Tasks',
      'List tasks in a project with filters for status, priority, assignee',
      '1.0.0'
    );
  }

  async execute(params: ListTasksParameters): Promise<ListTasksResult> {
    try {
      if (!params.projectId) {
        return this.prepareResult(false, undefined, 'projectId is required');
      }

      const result = await this.taskService.listTasks(params.projectId, {
        status: params.status,
        priority: params.priority,
        assignee: params.assignee,
        parentTaskId: params.parentTaskId,
        includeSubtasks: params.includeSubtasks,
        page: params.page,
        pageSize: params.pageSize
      });

      return {
        success: true,
        tasks: result.items,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          totalItems: result.totalItems,
          totalPages: result.totalPages,
          hasNextPage: result.hasNextPage
        }
      };
    } catch (error) {
      return { success: false, error: createErrorMessage('Failed to list tasks: ', error) };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID (REQUIRED)' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'], description: 'Filter by task status' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Filter by priority' },
        assignee: { type: 'string', description: 'Filter by assignee' },
        parentTaskId: { type: 'string', description: 'Filter by parent task (subtasks of this task)' },
        includeSubtasks: { type: 'boolean', description: 'Include subtasks in results (default: true)' },
        page: { type: 'number', description: 'Page number (0-indexed, default: 0)', minimum: 0 },
        pageSize: { type: 'number', description: 'Items per page (default: 20)', minimum: 1, maximum: 100 }
      },
      required: ['projectId']
    });
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        tasks: { type: 'array', items: { type: 'object' }, description: 'List of tasks' },
        pagination: { type: 'object', description: 'Pagination metadata' },
        error: { type: 'string' }
      }
    };
  }
}
