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

export class QueryTasksTool extends BaseTool<QueryTasksParameters, QueryTasksResult> {
  constructor(private taskService: TaskService) {
    super(
      'queryTasks',
      'Query Tasks',
      'DAG queries: get next actionable tasks, blocked tasks, or dependency tree for a task',
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
          return this.prepareResult(false, undefined,
            `Unknown query type: "${params.query}". Valid values: nextActions, blockedTasks, dependencyTree`);
      }
    } catch (error) {
      return { success: false, error: createErrorMessage('Failed to query tasks: ', error) };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to query (REQUIRED)' },
        query: {
          type: 'string',
          enum: ['nextActions', 'blockedTasks', 'dependencyTree'],
          description: 'Query type (REQUIRED). nextActions: tasks ready to work on (all deps done). blockedTasks: tasks waiting on incomplete deps. dependencyTree: full upstream/downstream graph for a specific task.'
        },
        taskId: { type: 'string', description: 'Task ID (REQUIRED for dependencyTree query)' }
      },
      required: ['projectId', 'query']
    });
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        query: { type: 'string', description: 'The query type that was executed' },
        tasks: { type: 'array', items: { type: 'object' }, description: 'Tasks for nextActions query' },
        blockedTasks: { type: 'array', items: { type: 'object' }, description: 'Blocked tasks with blocker details' },
        tree: { type: 'object', description: 'Dependency tree for dependencyTree query' },
        error: { type: 'string' }
      }
    };
  }
}
