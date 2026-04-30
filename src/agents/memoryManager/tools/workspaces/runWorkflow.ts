import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { BaseTool } from '../../../baseTool';
import { MemoryManagerAgent } from '../../memoryManager';
import { labelNamed, verbs } from '../../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { getNexusPlugin } from '../../../../utils/pluginLocator';
import type { WorkspaceWorkflow } from '../../../../database/types/workspace/WorkspaceTypes';
import type { WorkflowRunService } from '../../../../services/workflows/WorkflowRunService';
import type { NexusPluginWithServices } from '../utils/pluginTypes';
import type { CommonParameters, CommonResult } from '../../../../types';

interface RunWorkflowParameters extends CommonParameters {
  workspaceId: string;
  workflowId?: string;
  workflowName?: string;
  openInChat?: boolean;
}

interface RunWorkflowResult extends CommonResult {
  success: boolean;
  error?: string;
  data?: {
    workspaceId: string;
    workflowId: string;
    workflowName: string;
    conversationId: string;
    sessionId?: string;
  };
}

export class RunWorkflowTool extends BaseTool<RunWorkflowParameters, RunWorkflowResult> {
  constructor(private agent: MemoryManagerAgent) {
    super(
      'run',
      'Run Workflow',
      'Run a workspace workflow immediately and create a new conversation for it',
      '1.0.0'
    );
  }

  async execute(params: RunWorkflowParameters): Promise<RunWorkflowResult> {
    try {
      if (!params.workspaceId) {
        return { success: false, error: 'workspaceId is required.' };
      }

      if (!params.workflowId && !params.workflowName) {
        return { success: false, error: 'Provide workflowId or workflowName.' };
      }

      const workspaceService = await this.agent.getWorkspaceServiceAsync();
      if (!workspaceService) {
        return { success: false, error: 'Workspace service is not available.' };
      }

      const workspace = await workspaceService.getWorkspaceByNameOrId(params.workspaceId);
      if (!workspace) {
        return { success: false, error: `Workspace not found: ${params.workspaceId}` };
      }

      const workflow = this.findWorkflow(workspace.context?.workflows || [], params);
      if (!workflow) {
        return {
          success: false,
          error: params.workflowId
            ? `Workflow not found: ${params.workflowId}`
            : `Workflow not found: ${params.workflowName}`
        };
      }

      const workflowRunService = await this.getWorkflowRunService();
      if (!workflowRunService) {
        return { success: false, error: 'Workflow run service is not available.' };
      }

      const result = await workflowRunService.start({
        workspaceId: workspace.id,
        workflowId: workflow.id,
        runTrigger: 'manual',
        scheduledFor: Date.now(),
        openInChat: params.openInChat ?? false
      });

      return {
        success: true,
        data: {
          workspaceId: workspace.id,
          workflowId: workflow.id,
          workflowName: workflow.name,
          conversationId: result.conversationId,
          sessionId: result.sessionId
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelNamed(verbs('Running workflow', 'Ran workflow', 'Failed to run workflow'), params, tense, ['workflowName', 'workflowId']);
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      description: 'Run a workspace workflow immediately. Workflows are workspace-owned, so this belongs with workspace tools.',
      properties: {
        workspaceId: {
          type: 'string',
          description: 'Workspace ID or name.'
        },
        workflowId: {
          type: 'string',
          description: 'Workflow ID to run.'
        },
        workflowName: {
          type: 'string',
          description: 'Workflow name to run if workflowId is not known.'
        },
        openInChat: {
          type: 'boolean',
          description: 'Open and focus the new conversation in chat. Defaults to false for tool-driven runs.'
        }
      },
      required: ['workspaceId']
    });
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        error: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            workspaceId: { type: 'string' },
            workflowId: { type: 'string' },
            workflowName: { type: 'string' },
            conversationId: { type: 'string' },
            sessionId: { type: 'string' }
          }
        }
      },
      required: ['success']
    };
  }

  private findWorkflow(workflows: WorkspaceWorkflow[], params: RunWorkflowParameters): WorkspaceWorkflow | undefined {
    if (params.workflowId) {
      const byId = workflows.find(workflow => workflow.id === params.workflowId);
      if (byId) {
        return byId;
      }
    }

    if (params.workflowName) {
      const normalizedName = params.workflowName.trim().toLowerCase();
      return workflows.find(workflow => workflow.name.trim().toLowerCase() === normalizedName);
    }

    return undefined;
  }

  private async getWorkflowRunService(): Promise<WorkflowRunService | null> {
    const plugin = getNexusPlugin<NexusPluginWithServices>(this.agent.getApp());
    if (!plugin?.getService) {
      return null;
    }

    return await plugin.getService<WorkflowRunService>('workflowRunService');
  }
}
