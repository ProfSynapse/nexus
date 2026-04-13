/**
 * Location: src/agents/taskManager/tools/tasks/moveTask.ts
 * Purpose: Tool to move a task to a different project or change its parent task.
 *
 * Used by: TaskManagerAgent (via lazy tool registration)
 * Dependencies: TaskService
 */

import { BaseTool } from '../../../baseTool';
import { TaskService } from '../../services/TaskService';
import { MoveTaskParameters, MoveTaskResult } from '../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { ToolStatusTense } from '../../../interfaces/ITool';
import { verbs, labelWithId } from '../../../utils/toolStatusLabels';

export class MoveTaskTool extends BaseTool<MoveTaskParameters, MoveTaskResult> {
  constructor(private taskService: TaskService) {
    super(
      'moveTask',
      'Move Task',
      'Move a task to a different project within the same workspace, or change its parent task (set parentTaskId to nest as subtask, null to make top-level). Requires a taskId (from createTask or listTasks).',
      '1.0.0'
    );
  }

  async execute(params: MoveTaskParameters): Promise<MoveTaskResult> {
    try {
      if (!params.taskId) {
        return this.prepareResult(false, undefined, 'taskId is required');
      }
      if (!params.projectId && params.parentTaskId === undefined) {
        return this.prepareResult(false, undefined, 'At least one of projectId or parentTaskId must be provided');
      }

      await this.taskService.moveTask(params.taskId, {
        projectId: params.projectId,
        parentTaskId: params.parentTaskId
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: createErrorMessage('Failed to move task: ', error) };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to move (REQUIRED — from createTask or listTasks)' },
        projectId: { type: 'string', description: 'Target project ID to move the task to (from createProject or listProjects — must be in the same workspace)' },
        parentTaskId: {
          type: ['string', 'null'],
          description: 'New parent task ID (null to make top-level, string to nest under another task)'
        }
      },
      required: ['taskId']
    });
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const v = verbs('Moving task', 'Moved task', 'Failed to move task');
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
