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
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { labelNamed, verbs } from '../../../utils/toolStatusLabels';
import { formatTaskRef } from '../../utils/taskRefs';
import { ToolParamValidator } from '../../../validation/ToolParamValidator';

export class CreateTaskTool extends BaseTool<CreateTaskParameters, CreateTaskResult> {
  constructor(private taskService: TaskService) {
    super(
      'create',
      'Create Task',
      'Create a task within a project. Requires a projectId (from createProject or listProjects). Supports optional priority (critical/high/medium/low), assignee, dueDate, tags, dependsOn[] for DAG edges (cycles rejected), parentTaskId for subtask nesting, and linkedNotes[] for vault note links (each as a plain path string defaulting to reference, or an object { notePath, linkType } to set input/output/reference at creation). Returns the internal taskId and a short taskRef; prefer taskRef for later task operations.',
      '1.0.0'
    );
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelNamed(verbs('Creating task', 'Created task', 'Failed to create task'), params, tense, ['title', 'name']);
  }

  async execute(params: CreateTaskParameters): Promise<CreateTaskResult> {
    try {
      const projectId = ToolParamValidator.requireString(params.projectId, 'projectId');
      const title = ToolParamValidator.requireString(params.title, 'title');

      const taskId = await this.taskService.createTask(projectId, {
        title,
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

      return { success: true, taskId, taskRef: formatTaskRef(taskId) };
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
        parentTaskId: { type: 'string', description: 'Parent task ID or taskRef to nest this task under as a subtask (optional — from createTask or listTasks)' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Task priority (default: medium)' },
        dueDate: { type: 'number', description: 'Due date as Unix timestamp in milliseconds (e.g., Date.now() + 86400000 for tomorrow)' },
        assignee: { type: 'string', description: 'Assignee name or identifier (optional)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization (optional)' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task IDs or taskRefs this task depends on — creates DAG edges. Task cannot start until all dependencies are done. Cycles are rejected with an error.' },
        linkedNotes: {
          type: 'array',
          description: 'Vault notes to link to this task. Each item is EITHER a plain string vault path (linkType defaults to "reference") OR an object { notePath, linkType } to set the relationship explicitly. linkType values: input = the task DEPENDS ON / CONSUMES this note (required source material; a precondition — forms a data-flow edge). output = the task PRODUCES this note (the artifact/result — forms a data-flow edge). reference = related/contextual note the task does NOT consume (association only, not part of the data flow). Links can also be added or changed after creation via the linkNote tool or updateTask addNoteLinks.',
          items: {
            oneOf: [
              { type: 'string', description: 'Vault note path, e.g. "folder/note.md" (linkType defaults to reference)' },
              {
                type: 'object',
                properties: {
                  notePath: { type: 'string', description: 'Vault note path, e.g. "folder/note.md"' },
                  linkType: { type: 'string', enum: ['reference', 'output', 'input'], description: 'input=consumed/required source, output=produced artifact, reference=related but not consumed (default: reference)' }
                },
                required: ['notePath']
              }
            ]
          }
        },
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
        taskId: { type: 'string', description: 'Internal UUID of the created task' },
        taskRef: { type: 'string', description: 'Short task reference, e.g. T-1a2b3c4d. Prefer this as taskId in later task operations.' },
        error: { type: 'string' }
      }
    };
  }
}
