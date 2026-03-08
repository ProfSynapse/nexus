/**
 * Location: src/agents/taskManager/tools/tasks/updateTask.ts
 * Purpose: Tool to update task fields, status, or manage dependencies.
 *
 * Used by: TaskManagerAgent (via lazy tool registration)
 * Dependencies: TaskService
 */

import { BaseTool } from '../../../baseTool';
import { TaskService } from '../../services/TaskService';
import { UpdateTaskParameters, UpdateTaskResult } from '../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { createErrorMessage } from '../../../../utils/errorUtils';

export class UpdateTaskTool extends BaseTool<UpdateTaskParameters, UpdateTaskResult> {
  constructor(private taskService: TaskService) {
    super(
      'updateTask',
      'Update Task',
      'Update task fields, status, or manage dependencies',
      '1.0.0'
    );
  }

  async execute(params: UpdateTaskParameters): Promise<UpdateTaskResult> {
    try {
      if (!params.taskId) {
        return this.prepareResult(false, undefined, 'taskId is required');
      }

      // Update task fields
      const hasFieldUpdates = params.title || params.description !== undefined ||
        params.status || params.priority || params.dueDate !== undefined ||
        params.assignee !== undefined || params.tags || params.metadata;

      if (hasFieldUpdates) {
        await this.taskService.updateTask(params.taskId, {
          title: params.title,
          description: params.description,
          status: params.status,
          priority: params.priority,
          dueDate: params.dueDate,
          assignee: params.assignee,
          tags: params.tags,
          metadata: params.metadata
        });
      }

      // Add dependencies
      if (params.addDependencies && params.addDependencies.length > 0) {
        for (const depId of params.addDependencies) {
          await this.taskService.addDependency(params.taskId, depId);
        }
      }

      // Remove dependencies
      if (params.removeDependencies && params.removeDependencies.length > 0) {
        for (const depId of params.removeDependencies) {
          await this.taskService.removeDependency(params.taskId, depId);
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: createErrorMessage('Failed to update task: ', error) };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to update (REQUIRED)' },
        title: { type: 'string', description: 'New task title' },
        description: { type: 'string', description: 'New task description' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'], description: 'New task status' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'New task priority' },
        dueDate: { type: 'number', description: 'New due date as Unix timestamp (milliseconds)' },
        assignee: { type: 'string', description: 'New assignee' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replace tags array' },
        addDependencies: { type: 'array', items: { type: 'string' }, description: 'Task IDs to add as dependencies (validates no cycles)' },
        removeDependencies: { type: 'array', items: { type: 'string' }, description: 'Task IDs to remove from dependencies' },
        metadata: { type: 'object', description: 'Custom metadata to merge', additionalProperties: true }
      },
      required: ['taskId']
    });
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        error: { type: 'string' }
      }
    };
  }
}
