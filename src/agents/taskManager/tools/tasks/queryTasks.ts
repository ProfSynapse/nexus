/**
 * Location: src/agents/taskManager/tools/tasks/queryTasks.ts
 * Purpose: Tool for DAG queries — next actionable tasks, blocked tasks, or dependency tree.
 *
 * Used by: TaskManagerAgent (via lazy tool registration)
 * Dependencies: TaskService
 */

import { BaseTool } from '../../../baseTool';
import { TaskService } from '../../services/TaskService';
import { QueryTasksParameters, QueryTasksResult } from '../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { ToolStatusTense } from '../../../interfaces/ITool';
import { verbs, labelNamed } from '../../../utils/toolStatusLabels';

export class QueryTasksTool extends BaseTool<QueryTasksParameters, QueryTasksResult> {
  constructor(private taskService: TaskService) {
    super(
      'query',
      'Query Tasks',
      'DAG-aware queries on a project\'s tasks. Three query types: nextActions returns tasks ready to start (status=todo and all dependencies done), blockedTasks returns tasks waiting on incomplete dependencies with their blocker details, dependencyTree returns the full upstream/downstream dependency graph for a specific task. Requires projectId; dependencyTree also requires taskId.',
      '1.0.0'
    );
  }

  async execute(params: QueryTasksParameters): Promise<QueryTasksResult> {
    try {
      if (!params.projectId) {
        return this.prepareResult(false, undefined, 'projectId is required');
      }
      if (!params.query) {
        return this.prepareResult(false, undefined, 'query is required (nextActions, blockedTasks, or dependencyTree)');
      }

      switch (params.query) {
        case 'nextActions': {
          const tasks = await this.taskService.getNextActions(params.projectId);
          return { success: true, query: 'nextActions', tasks };
        }

        case 'blockedTasks': {
          const blocked = await this.taskService.getBlockedTasks(params.projectId);
          return { success: true, query: 'blockedTasks', blockedTasks: blocked };
        }

        case 'dependencyTree': {
          if (!params.taskId) {
            return this.prepareResult(false, undefined, 'taskId is required for dependencyTree query');
          }
          const tree = await this.taskService.getDependencyTree(params.taskId);
          return { success: true, query: 'dependencyTree', tree };
        }

        default:
          return this.prepareResult(false, undefined, 'Unknown query type');
      }
    } catch (error) {
      return { success: false, error: createErrorMessage('Failed to query tasks: ', error) };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to query (REQUIRED — from createProject or listProjects)' },
        query: {
          type: 'string',
          enum: ['nextActions', 'blockedTasks', 'dependencyTree'],
          description: 'Query type (REQUIRED). nextActions: tasks with status=todo whose dependencies are all done — these are ready to start. blockedTasks: tasks waiting on incomplete dependencies, returned with their blocker details. dependencyTree: full upstream/downstream dependency graph for a specific task (requires taskId).'
        },
        taskId: { type: 'string', description: 'Task ID (REQUIRED for dependencyTree query — from createTask or listTasks)' }
      },
      required: ['projectId', 'query']
    });
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const v = verbs('Querying tasks', 'Queried tasks', 'Failed to query tasks');
    return labelNamed(v, params, tense, ['query']);
  }

  getResultSchema(): JSONSchema {
    const taskObjectSchema: JSONSchema = {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
        projectId: { type: 'string', description: 'Parent project ID' },
        workspaceId: { type: 'string', description: 'Parent workspace ID' },
        parentTaskId: { type: 'string', description: 'Parent task ID if subtask (null if top-level)' },
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'], description: 'Task status' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Task priority' },
        created: { type: 'number', description: 'Creation timestamp (ms since epoch)' },
        updated: { type: 'number', description: 'Last update timestamp (ms since epoch)' },
        completedAt: { type: 'number', description: 'Completion timestamp (ms since epoch, only when status=done)' },
        dueDate: { type: 'number', description: 'Due date timestamp (ms since epoch)' },
        assignee: { type: 'string', description: 'Assigned person or identifier' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Categorization tags' },
        metadata: { type: 'object', description: 'Custom metadata key-value pairs' }
      }
    };

    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        query: { type: 'string', enum: ['nextActions', 'blockedTasks', 'dependencyTree'], description: 'The query type that was executed' },
        tasks: {
          type: 'array',
          description: 'Returned for nextActions query — tasks with status=todo whose dependencies are all done (ready to start)',
          items: taskObjectSchema
        },
        blockedTasks: {
          type: 'array',
          description: 'Returned for blockedTasks query — tasks that cannot start because they have incomplete dependencies',
          items: {
            type: 'object',
            properties: {
              task: { ...taskObjectSchema, description: 'The blocked task' },
              blockedBy: {
                type: 'array',
                description: 'Tasks that must complete before the blocked task can start',
                items: taskObjectSchema
              }
            }
          }
        },
        tree: {
          type: 'object',
          description: 'Returned for dependencyTree query — recursive upstream/downstream dependency graph for the specified task',
          properties: {
            task: { ...taskObjectSchema, description: 'The root task of the tree' },
            dependencies: {
              type: 'array',
              description: 'Upstream tasks this task depends on (recursive — each has its own dependencies/dependents)',
              items: { type: 'object', description: 'Recursive DependencyTree node with task, dependencies[], and dependents[]' }
            },
            dependents: {
              type: 'array',
              description: 'Downstream tasks that depend on this task (recursive — each has its own dependencies/dependents)',
              items: { type: 'object', description: 'Recursive DependencyTree node with task, dependencies[], and dependents[]' }
            }
          }
        },
        error: { type: 'string' }
      }
    };
  }
}
