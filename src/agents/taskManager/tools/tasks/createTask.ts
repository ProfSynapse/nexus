/**
 * Location: src/agents/taskManager/tools/tasks/createTask.ts
 * Purpose: Tool to create a task with optional dependencies, subtask parent, priority, and note links.
 *
 * Used by: TaskManagerAgent (via lazy tool registration)
 * Dependencies: TaskService
 */

import { BaseTool } from '../../../baseTool';
import { TaskService } from '../../services/TaskService';
import { CreateTaskParameters, CreateTaskResult } from '../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { createErrorMessage } from '../../../../utils/errorUtils';

export class CreateTaskTool extends BaseTool<CreateTaskParameters, CreateTaskResult> {
  constructor(private taskService: TaskService) {
    super(
      'createTask',
      'Create Task',
      'Create a task within a project. Requires a projectId (from createProject or listProjects). Supports optional priority (critical/high/medium/low), assignee, dueDate, tags, dependsOn[] for DAG edges (cycles rejected), parentTaskId for subtask nesting, and linkedNotes[] for vault note links. Returns the new taskId.',
      '1.0.0'
    );
  }

  async execute(params: CreateTaskParameters): Promise<CreateTaskResult> {
    try {
      if (!params.projectId) {
        return this.prepareResult(false, undefined, 'projectId is required');
      }
      if (!params.title) {
        return this.prepareResult(false, undefined, 'title is required');
      }

      const taskId = await this.taskService.createTask(params.projectId, {
        title: params.title,
        description: params.description,
        parentTaskId: params.parentTaskId,
        priority: params.priority,
        dueDate: params.dueDate,
        assignee: params.assignee,
        tags: params.tags,
        dependsOn: params.dependsOn,
        linkedNotes: params.linkedNotes,
        metadata: params.metadata
      });

      return { success: true, taskId };
    } catch (error) {
      return { success: false, error: createErrorMessage('Failed to create task: ', error) };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to create the task in (REQUIRED — from createProject or listProjects)' },
        title: { type: 'string', description: 'Task title (REQUIRED)' },
        description: { type: 'string', description: 'Task description (optional)' },
        parentTaskId: { type: 'string', description: 'Parent task ID to nest this task under as a subtask (optional — from createTask or listTasks)' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Task priority (default: medium)' },
        dueDate: { type: 'number', description: 'Due date as Unix timestamp in milliseconds (e.g., Date.now() + 86400000 for tomorrow)' },
        assignee: { type: 'string', description: 'Assignee name or identifier (optional)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization (optional)' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task IDs this task depends on — creates DAG edges. Task cannot start until all dependencies are done. Cycles are rejected with an error.' },
        linkedNotes: { type: 'array', items: { type: 'string' }, description: 'Vault note paths to link to this task (link type defaults to reference)' },
        metadata: { type: 'object', description: 'Custom metadata key-value pairs (optional)', additionalProperties: true }
      },
      required: ['projectId', 'title']
    });
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        taskId: { type: 'string', description: 'ID of the created task' },
        error: { type: 'string' }
      }
    };
  }
}
