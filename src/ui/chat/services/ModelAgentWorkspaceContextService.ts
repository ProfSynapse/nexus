import type { WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';

interface WorkspaceIntegrationLike {
  loadWorkspace(workspaceId: string): Promise<Record<string, unknown> | null>;
  bindSessionToWorkspace(sessionId: string | undefined, workspaceId: string): Promise<void>;
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
      ) as WorkspaceContext | null;

      await this.workspaceIntegration.bindSessionToWorkspace(sessionId, selectedWorkspaceId);

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

  async loadSelectedWorkspace(
    workspaceId: string,
    sessionId?: string
  ): Promise<ModelAgentWorkspaceState> {
    try {
      const fullWorkspaceData = await this.workspaceIntegration.loadWorkspace(workspaceId);

      await this.workspaceIntegration.bindSessionToWorkspace(sessionId, workspaceId);

      return {
        selectedWorkspaceId: workspaceId,
        workspaceContext: null,
        loadedWorkspaceData: fullWorkspaceData
      };
    } catch (error) {
      console.error('[ModelAgentWorkspaceContextService] Failed to load selected workspace:', error);
      return {
        selectedWorkspaceId: workspaceId,
        workspaceContext: null,
        loadedWorkspaceData: null
      };
    }
  }
}
