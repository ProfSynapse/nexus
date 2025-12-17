/**
 * Location: /src/ui/chat/services/WorkspaceIntegrationService.ts
 *
 * Purpose: Handles workspace loading, session binding, and dynamic context retrieval
 * Extracted from ModelAgentManager.ts to follow Single Responsibility Principle
 *
 * Used by: ModelAgentManager for workspace operations and dynamic context
 * Dependencies: WorkspaceService, SessionContextManager, Obsidian Vault API
 */

import { App, TFile, TFolder } from 'obsidian';
import { WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';
import { VaultStructure, WorkspaceSummary } from './SystemPromptBuilder';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import type NexusPlugin from '../../../main';
import type { WorkspaceService } from '../../../services/WorkspaceService';
import type { SessionContextManager } from '../../../services/SessionContextManager';
import type { AgentManager } from '../../../services/AgentManager';
import type { IAgent } from '../../../agents/interfaces/IAgent';

/**
 * Service for workspace integration with chat
 */
export class WorkspaceIntegrationService {
  constructor(private app: App) {}

  /**
   * Load workspace by ID with full context (like loadWorkspace tool)
   * This executes the LoadWorkspaceTool to get comprehensive data including file structure
   */
  async loadWorkspace(workspaceId: string): Promise<Record<string, unknown> | null> {
    try {
      const plugin = getNexusPlugin<NexusPlugin>(this.app);
      if (!plugin) {
        return null;
      }

      // Try to get the agentManager and memoryManager agent
      const agentManager = await plugin.getService<AgentManager>('agentManager');

      if (agentManager) {
        try {
          const memoryManager = agentManager.getAgent('memoryManager');

          if (memoryManager) {
            // Execute loadWorkspace tool to get comprehensive workspace data
            const result = await memoryManager.executeTool('loadWorkspace', {
              id: workspaceId,
              limit: 3 // Get recent sessions, states, and activity
            });

            if (result.success && result.data) {
              // Return the comprehensive workspace data from the tool
              return {
                id: workspaceId,
                ...result.data,
                // Keep the workspace context from the result
                workspaceContext: result.workspaceContext
              };
            }
          }
        } catch (agentError) {
          // If agent execution fails, fall through to basic workspace loading
          console.error('[WorkspaceIntegrationService] Agent execution failed:', agentError);
        }
      }

      // Fallback: just load basic workspace data if LoadWorkspaceTool fails
      const workspaceService = await plugin.getService<WorkspaceService>('workspaceService');
      if (workspaceService) {
        const workspace = await workspaceService.getWorkspace(workspaceId);
        // Convert IndividualWorkspace to Record<string, unknown> for dynamic usage
        return workspace as unknown as Record<string, unknown>;
      }

      return null;
    } catch (error) {
      console.error(`Error loading workspace ${workspaceId}:`, error);

      // Fallback: try basic workspace loading
      try {
        const plugin = getNexusPlugin<NexusPlugin>(this.app);
        const workspaceService = await plugin?.getService<WorkspaceService>('workspaceService');
        if (workspaceService) {
          const workspace = await workspaceService.getWorkspace(workspaceId);
          // Convert IndividualWorkspace to Record<string, unknown> for dynamic usage
          return workspace as unknown as Record<string, unknown>;
        }
      } catch (fallbackError) {
        console.error(`Fallback workspace loading also failed:`, fallbackError);
      }

      return null;
    }
  }

  /**
   * Read note content from vault
   */
  async readNoteContent(notePath: string): Promise<string> {
    try {
      const file = this.app.vault.getAbstractFileByPath(notePath);

      if (file instanceof TFile) {
        const content = await this.app.vault.read(file);
        return content;
      }

      return '[File not found]';
    } catch (error) {
      return '[Error reading file]';
    }
  }

  /**
   * Bind a session to a workspace in SessionContextManager
   */
  async bindSessionToWorkspace(sessionId: string | undefined, workspaceId: string): Promise<void> {
    if (!sessionId) {
      return;
    }

    try {
      const plugin = getNexusPlugin<NexusPlugin>(this.app);
      if (!plugin) {
        return;
      }

      const sessionContextManager = await plugin.getService<SessionContextManager>('sessionContextManager');

      if (sessionContextManager) {
        sessionContextManager.setWorkspaceContext(sessionId, {
          workspaceId: workspaceId,
          activeWorkspace: true
        });
      }
    } catch (error) {
      console.error('[WorkspaceIntegrationService] Failed to bind session to workspace:', error);
    }
  }

  /**
   * Get the root-level vault structure (folders and files)
   * Used to give the LLM awareness of the vault's organization
   */
  getVaultStructure(): VaultStructure {
    const rootFolders: string[] = [];
    const rootFiles: string[] = [];

    try {
      const root = this.app.vault.getRoot();

      if (root && root.children) {
        for (const child of root.children) {
          if (child instanceof TFolder) {
            // Skip hidden folders (starting with .)
            if (!child.name.startsWith('.')) {
              rootFolders.push(child.name);
            }
          } else if (child instanceof TFile) {
            // Skip hidden files (starting with .)
            if (!child.name.startsWith('.')) {
              rootFiles.push(child.name);
            }
          }
        }
      }

      // Sort alphabetically for consistent presentation
      rootFolders.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      rootFiles.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    } catch (error) {
      console.error('[WorkspaceIntegrationService] Failed to get vault structure:', error);
    }

    return { rootFolders, rootFiles };
  }

  /**
   * Get all available workspaces with summary information
   * Used to give the LLM awareness of what workspaces exist
   */
  async listAvailableWorkspaces(): Promise<WorkspaceSummary[]> {
    try {
      const plugin = getNexusPlugin<NexusPlugin>(this.app);
      if (!plugin) {
        return [];
      }

      const workspaceService = await plugin.getService<WorkspaceService>('workspaceService');

      if (!workspaceService) {
        return [];
      }

      // Use listWorkspaces for lightweight index-based listing
      const workspaces = await workspaceService.listWorkspaces();

      return workspaces.map((ws) => ({
        id: ws.id,
        name: ws.name,
        description: ws.description || undefined,
        rootFolder: ws.rootFolder || '/'
      }));
    } catch (error) {
      console.error('[WorkspaceIntegrationService] Failed to list workspaces:', error);
      return [];
    }
  }
}
