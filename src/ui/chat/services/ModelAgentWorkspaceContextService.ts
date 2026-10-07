import type { WorkspaceLoadValidation } from '../../../services/workspace/WorkspaceLoadService';
import type { WorkflowPreparationBudget } from '../../../services/workflows/WorkflowPreparationService';
import type { WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';

interface WorkspaceIntegrationLike {
  loadWorkspace(workspaceId: string): Promise<Record<string, unknown> | null>;
  activateWorkspace(workspaceId: string, sessionId: string, workflow?: string, budget?: WorkflowPreparationBudget, validate?: WorkspaceLoadValidation): Promise<Record<string, unknown>>;
}

export interface ModelAgentWorkspaceState {
  selectedWorkspaceId: string | null;
  workspaceContext: WorkspaceContext | null;
  loadedWorkspaceData: Record<string, unknown> | null;
}

export class ModelAgentWorkspaceContextService {
  constructor(private readonly workspaceIntegration: WorkspaceIntegrationLike) {}

  createEmptyState(): ModelAgentWorkspaceState {
    return {
      selectedWorkspaceId: null,
      workspaceContext: null,
      loadedWorkspaceData: null
    };
  }

  async restoreWorkspace(
    workspaceId: string,
    sessionId?: string
  ): Promise<ModelAgentWorkspaceState> {
    try {
      const fullWorkspaceData = await this.workspaceIntegration.loadWorkspace(workspaceId);
      if (!fullWorkspaceData) {
        return this.createEmptyState();
      }

      const selectedWorkspaceId = (fullWorkspaceData.id as string) || workspaceId;
      const workspaceContext = (
        fullWorkspaceData.context || fullWorkspaceData.workspaceContext || null
      );

      // Restoring conversation context is a passive read.
      void sessionId;

      return {
        selectedWorkspaceId,
        workspaceContext,
        loadedWorkspaceData: fullWorkspaceData
      };
    } catch (error) {
      console.error('[ModelAgentWorkspaceContextService] Failed to restore workspace:', error);
      return this.createEmptyState();
    }
  }

  async loadSelectedWorkspace(workspaceId: string, sessionId: string, workflow?: string, budget?: WorkflowPreparationBudget, validate?: WorkspaceLoadValidation): Promise<ModelAgentWorkspaceState> {
    const fullWorkspaceData = await this.workspaceIntegration.activateWorkspace(workspaceId, sessionId, workflow, budget, validate);
    return {
      selectedWorkspaceId: typeof fullWorkspaceData.id === 'string' ? fullWorkspaceData.id : workspaceId,
      workspaceContext: null,
      loadedWorkspaceData: fullWorkspaceData,
    };
  }
}
