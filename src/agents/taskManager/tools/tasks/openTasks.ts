import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { BaseTool } from '../../../baseTool';
import { OpenTasksParameters, OpenTasksResult } from '../../types';
import { openTaskBoardView, type TaskBoardOpenMode } from '../../../../ui/tasks/taskBoardNavigation';
import { createErrorMessage } from '../../../../utils/errorUtils';
import type { App } from 'obsidian';
import { ToolStatusTense } from '../../../interfaces/ITool';
import { verbs, labelQuery } from '../../../utils/toolStatusLabels';

export class OpenTasksTool extends BaseTool<OpenTasksParameters, OpenTasksResult> {
  constructor(private app: App) {
    super(
      'openTasks',
      'Open Tasks',
      'Open the native Task Board workspace view in Obsidian. Optional filters let you preselect a workspace, project, or search query before the board is shown.',
      '1.0.0'
    );
  }

  async execute(params: OpenTasksParameters): Promise<OpenTasksResult> {
    try {
      const mode = (params.mode || 'tab') as TaskBoardOpenMode;
      const leaf = await openTaskBoardView(this.app, {
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        search: params.search
      }, mode);

      if (!leaf) {
        return this.prepareResult(false, undefined, 'Failed to open task board view');
      }

      return {
        success: true,
        opened: true,
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        search: params.search,
        mode
      };
    } catch (error) {
      return {
        success: false,
        error: createErrorMessage('Failed to open task board: ', error)
      };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string',
          description: 'Optional workspace ID to preselect in the board filter.'
        },
        projectId: {
          type: 'string',
          description: 'Optional project ID to preselect in the board filter.'
        },
        search: {
          type: 'string',
          description: 'Optional search query to prefill in the board search input.'
        },
        mode: {
          type: 'string',
          enum: ['tab', 'split', 'current', 'sidebar'],
          description: 'Where to open the task board view.',
          default: 'tab'
        }
      }
    });
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const v = verbs('Opening task board', 'Opened task board', 'Failed to open task board');
    return labelQuery(v, params, tense, ['search']);
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        opened: { type: 'boolean' },
        workspaceId: { type: 'string' },
        projectId: { type: 'string' },
        search: { type: 'string' },
        mode: { type: 'string' },
        error: { type: 'string' }
      }
    };
  }
}
