/**
 * Location: src/agents/taskManager/tools/projects/archiveProject.ts
 * Purpose: Tool to archive a project (soft-delete by setting status to 'archived').
 *
 * Used by: TaskManagerAgent (via lazy tool registration)
 * Dependencies: TaskService
 */

import { BaseTool } from '../../../baseTool';
import { TaskService } from '../../services/TaskService';
import { ArchiveProjectParameters, ArchiveProjectResult } from '../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { createErrorMessage } from '../../../../utils/errorUtils';

export class ArchiveProjectTool extends BaseTool<ArchiveProjectParameters, ArchiveProjectResult> {
  constructor(private taskService: TaskService) {
    super(
      'archiveProject',
      'Archive Project',
      'Archive a project by setting its status to \'archived\' (soft-delete). The project and its tasks remain queryable but are excluded from active listings. Requires a projectId (from createProject or listProjects).',
      '1.0.0'
    );
  }

  async execute(params: ArchiveProjectParameters): Promise<ArchiveProjectResult> {
    try {
      if (!params.projectId) {
        return this.prepareResult(false, undefined, 'projectId is required');
      }

      await this.taskService.archiveProject(params.projectId);
      return { success: true };
    } catch (error) {
      return { success: false, error: createErrorMessage('Failed to archive project: ', error) };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to archive (REQUIRED — from createProject or listProjects)' }
      },
      required: ['projectId']
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
