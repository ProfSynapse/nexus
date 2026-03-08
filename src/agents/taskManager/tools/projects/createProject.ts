/**
 * Location: src/agents/taskManager/tools/projects/createProject.ts
 * Purpose: Tool to create a new project within a workspace.
 *
 * Used by: TaskManagerAgent (via lazy tool registration)
 * Dependencies: TaskService
 */

import { BaseTool } from '../../../baseTool';
import { TaskService } from '../../services/TaskService';
import { CreateProjectParameters, CreateProjectResult } from '../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { createErrorMessage } from '../../../../utils/errorUtils';

export class CreateProjectTool extends BaseTool<CreateProjectParameters, CreateProjectResult> {
  constructor(private taskService: TaskService) {
    super(
      'createProject',
      'Create Project',
      'Create a new project within a workspace',
      '1.0.0'
    );
  }

  async execute(params: CreateProjectParameters): Promise<CreateProjectResult> {
    try {
      if (!params.workspaceId) {
        return this.prepareResult(false, undefined, 'workspaceId is required');
      }
      if (!params.name) {
        return this.prepareResult(false, undefined, 'name is required');
      }

      const projectId = await this.taskService.createProject(params.workspaceId, {
        name: params.name,
        description: params.description,
        metadata: params.metadata
      });

      return { success: true, projectId };
    } catch (error) {
      return { success: false, error: createErrorMessage('Failed to create project: ', error) };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID to create the project in (REQUIRED)' },
        name: { type: 'string', description: 'Project name (REQUIRED, must be unique within workspace)' },
        description: { type: 'string', description: 'Project description' },
        metadata: { type: 'object', description: 'Custom metadata key-value pairs', additionalProperties: true }
      },
      required: ['workspaceId', 'name']
    });
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        projectId: { type: 'string', description: 'ID of the created project' },
        error: { type: 'string' }
      }
    };
  }
}
