/**
 * Location: src/agents/taskManager/tools/projects/updateProject.ts
 * Purpose: Tool to update project metadata or status.
 *
 * Used by: TaskManagerAgent (via lazy tool registration)
 * Dependencies: TaskService
 */

import { BaseTool } from '../../../baseTool';
import { TaskService } from '../../services/TaskService';
import { UpdateProjectParameters, UpdateProjectResult } from '../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { ToolStatusTense } from '../../../interfaces/ITool';
import { verbs, labelWithId } from '../../../utils/toolStatusLabels';

export class UpdateProjectTool extends BaseTool<UpdateProjectParameters, UpdateProjectResult> {
  constructor(private taskService: TaskService) {
    super(
      'updateProject',
      'Update Project',
      'Update a project\'s name, description, status (active/completed/archived), or custom metadata. Requires a projectId (from createProject or listProjects).',
      '1.0.0'
    );
  }

  async execute(params: UpdateProjectParameters): Promise<UpdateProjectResult> {
    try {
      if (!params.projectId) {
        return this.prepareResult(false, undefined, 'projectId is required');
      }

      await this.taskService.updateProject(params.projectId, {
        name: params.name,
        description: params.description,
        status: params.status,
        metadata: params.metadata
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: createErrorMessage('Failed to update project: ', error) };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to update (REQUIRED — from createProject or listProjects)' },
        name: { type: 'string', description: 'New project name' },
        description: { type: 'string', description: 'New project description' },
        status: { type: 'string', enum: ['active', 'completed', 'archived'], description: 'New project status' },
        metadata: { type: 'object', description: 'Custom metadata to merge', additionalProperties: true }
      },
      required: ['projectId']
    });
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const v = verbs('Updating project', 'Updated project', 'Failed to update project');
    return labelWithId(v, params, tense, { keys: ['projectId'], fallback: 'project' });
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
