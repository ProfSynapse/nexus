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
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { labelNamed, verbs } from '../../../utils/toolStatusLabels';

export class CreateProjectTool extends BaseTool<CreateProjectParameters, CreateProjectResult> {
  constructor(private taskService: TaskService) {
    super(
      'createProject',
      'Create Project',
      'Create a new project within a workspace. Projects organize tasks and must have a unique name per workspace. Requires a workspaceId (from loadWorkspace or createWorkspace). Returns the new projectId.',
      '1.0.0'
    );
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelNamed(verbs('Creating project', 'Created project', 'Failed to create project'), params, tense, ['name', 'title']);
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
        workspaceId: { type: 'string', description: 'Workspace ID (REQUIRED — from loadWorkspace or createWorkspace)' },
        name: { type: 'string', description: 'Project name (REQUIRED — must be unique within the workspace)' },
        description: { type: 'string', description: 'Project description (optional)' },
        metadata: { type: 'object', description: 'Custom metadata key-value pairs (optional)', additionalProperties: true }
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
