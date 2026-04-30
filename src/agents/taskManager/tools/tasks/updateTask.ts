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
import { ToolStatusTense } from '../../../interfaces/ITool';
import { verbs, labelWithId } from '../../../utils/toolStatusLabels';

export class UpdateTaskTool extends BaseTool<UpdateTaskParameters, UpdateTaskResult> {
  constructor(private taskService: TaskService) {
    super(
      'update',
      'Update Task',
      'Update task fields (title, description, status, priority, dueDate, assignee, tags), manage DAG dependencies (addDependencies/removeDependencies), and manage note links (addNoteLinks/removeNoteLinks). Dependency additions are validated for cycles. Requires a taskId (from createTask or listTasks).',
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

      // Add note links
      if (params.addNoteLinks && params.addNoteLinks.length > 0) {
        for (const link of params.addNoteLinks) {
          await this.taskService.linkNote(params.taskId, link.notePath, link.linkType ?? 'reference');
        }
      }

      // Remove note links
      if (params.removeNoteLinks && params.removeNoteLinks.length > 0) {
        for (const notePath of params.removeNoteLinks) {
          await this.taskService.unlinkNote(params.taskId, notePath);
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
        taskId: { type: 'string', description: 'Task ID to update (REQUIRED — from createTask or listTasks)' },
        title: { type: 'string', description: 'New task title' },
        description: { type: 'string', description: 'New task description' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'], description: 'New task status (setting to done auto-records completedAt timestamp)' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'New task priority' },
        dueDate: { type: 'number', description: 'New due date as Unix timestamp in milliseconds (e.g., Date.now() + 86400000 for tomorrow)' },
        assignee: { type: 'string', description: 'New assignee name or identifier' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replace entire tags array with these values' },
        addDependencies: { type: 'array', items: { type: 'string' }, description: 'Task IDs to add as DAG dependencies — this task cannot start until these are done. Cycles are rejected with an error.' },
        removeDependencies: { type: 'array', items: { type: 'string' }, description: 'Task IDs to remove from this task\'s dependencies' },
        addNoteLinks: {
          type: 'array',
          description: 'Vault notes to link to this task',
          items: {
            type: 'object',
            properties: {
              notePath: { type: 'string', description: 'Vault note path, e.g. "folder/note.md"' },
              linkType: { type: 'string', enum: ['reference', 'output', 'input'], description: 'Type of link (default: reference)' }
            },
            required: ['notePath']
          }
        },
        removeNoteLinks: { type: 'array', items: { type: 'string' }, description: 'Vault note paths to unlink from this task' },
        metadata: { type: 'object', description: 'Custom metadata to merge (keys are merged, not replaced)', additionalProperties: true }
      },
      required: ['taskId']
    });
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const v = verbs('Updating task', 'Updated task', 'Failed to update task');
    return labelWithId(v, params, tense, { keys: ['taskId'], fallback: 'task' });
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
