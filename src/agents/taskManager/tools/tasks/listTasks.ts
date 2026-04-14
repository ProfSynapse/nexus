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
import { ToolStatusTense } from '../../../interfaces/ITool';
import { verbs } from '../../../utils/toolStatusLabels';

export class ListTasksTool extends BaseTool<ListTasksParameters, ListTasksResult> {
  constructor(private taskService: TaskService) {
    super(
      'listTasks',
      'List Tasks',
      'List tasks in a project with optional filters for status (todo/in_progress/done/cancelled), priority, assignee, and parentTaskId. Returns paginated task objects with full metadata including dependencies and timestamps.',
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
        sortBy: params.sortBy,
        sortOrder: params.sortOrder,
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
        projectId: { type: 'string', description: 'Project ID (REQUIRED — from createProject or listProjects)' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'], description: 'Filter by task status' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Filter by priority' },
        assignee: { type: 'string', description: 'Filter by assignee' },
        parentTaskId: { type: 'string', description: 'Filter by parent task (subtasks of this task)' },
        includeSubtasks: { type: 'boolean', description: 'Include subtasks in results (default: true)' },
        sortBy: { type: 'string', enum: ['created', 'updated', 'priority', 'title', 'dueDate'], description: 'Sort field (default: updated)' },
        sortOrder: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default: desc)' },
        page: { type: 'number', description: 'Page number (0-indexed, default: 0)', minimum: 0 },
        pageSize: { type: 'number', description: 'Items per page (default: 20)', minimum: 1, maximum: 100 }
      },
      required: ['projectId']
    });
  }

  getStatusLabel(_params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const v = verbs('Listing tasks', 'Listed tasks', 'Failed to list tasks');
    return v[tense];
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        tasks: {
          type: 'array',
          description: 'List of task objects',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Task ID (use as taskId in other task operations)' },
              projectId: { type: 'string', description: 'Parent project ID' },
              workspaceId: { type: 'string', description: 'Parent workspace ID' },
              parentTaskId: { type: 'string', description: 'Parent task ID if this is a subtask (null if top-level)' },
              title: { type: 'string', description: 'Task title' },
              description: { type: 'string', description: 'Task description' },
              status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'], description: 'Task status' },
              priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Task priority' },
              created: { type: 'number', description: 'Creation timestamp (ms since epoch)' },
              updated: { type: 'number', description: 'Last update timestamp (ms since epoch)' },
              completedAt: { type: 'number', description: 'Completion timestamp (ms since epoch, only set when status=done)' },
              dueDate: { type: 'number', description: 'Due date timestamp (ms since epoch)' },
              assignee: { type: 'string', description: 'Assigned person or identifier' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Categorization tags' },
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
            totalItems: { type: 'number', description: 'Total number of matching tasks' },
            totalPages: { type: 'number', description: 'Total number of pages' },
            hasNextPage: { type: 'boolean', description: 'Whether more pages are available' }
          }
        },
        error: { type: 'string' }
      }
    };
  }
}
