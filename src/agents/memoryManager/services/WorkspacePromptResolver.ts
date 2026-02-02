/**
 * Location: /src/agents/memoryManager/services/WorkspacePromptResolver.ts
 * Purpose: Resolves custom prompt information from workspaces
 *
 * This service handles looking up custom prompt data associated with workspaces,
 * supporting both ID-based and unified name/ID lookup with backward
 * compatibility for legacy workspace structures.
 *
 * Used by: LoadWorkspaceMode for resolving workspace prompts
 * Integrates with: Plugin settings (data.json customPrompts)
 *
 * Responsibilities:
 * - Resolve workspace prompt from dedicatedAgent or legacy agents array
 * - Fetch prompt data by ID (for when ID is known)
 * - Fetch prompt data by name or ID (unified lookup)
 */

import type { App } from 'obsidian';
import { ProjectWorkspace, WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';

/**
 * Prompt information returned from resolution operations
 */
export interface WorkspacePromptInfo {
  id: string;
  name: string;
  systemPrompt: string;
}

/**
 * Legacy workspace context structure for backward compatibility
 * Extends the current WorkspaceContext with deprecated fields
 */
interface LegacyWorkspaceContext extends WorkspaceContext {
  agents?: Array<{
    name: string;
    [key: string]: unknown;
  }>;
}

/**
 * Service for resolving workspace prompts (custom prompts associated with workspaces)
 * Implements Single Responsibility Principle - only handles prompt resolution
 */
export class WorkspacePromptResolver {
  private app: App;
  private plugin: any;

  constructor(app: App, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }

  /**
   * Fetch workspace prompt data if available
   * Handles both new dedicatedAgent structure and legacy agents array
   * @param workspace The workspace to fetch prompt from
   * @param app The Obsidian app instance
   * @returns Prompt info or null if not available
   */
  async fetchWorkspacePrompt(
    workspace: ProjectWorkspace,
    app: App
  ): Promise<WorkspacePromptInfo | null> {
    try {
      // Check top-level dedicatedAgentId field first (new storage location)
      const workspaceWithId = workspace as ProjectWorkspace & { dedicatedAgentId?: string };
      const dedicatedAgentId = workspaceWithId.dedicatedAgentId;

      console.error('[WorkspacePromptResolver] fetchWorkspacePrompt called with dedicatedAgentId:', dedicatedAgentId);
      console.error('[WorkspacePromptResolver] workspace.context.dedicatedAgent:', JSON.stringify(workspace.context?.dedicatedAgent));

      if (dedicatedAgentId) {
        // Use top-level dedicatedAgentId (name or ID)
        return await this.fetchPromptByNameOrId(dedicatedAgentId, app);
      }

      // Fall back to context.dedicatedAgent for backward compatibility
      if (workspace.context?.dedicatedAgent) {
        const { agentId } = workspace.context.dedicatedAgent;
        return await this.fetchPromptByNameOrId(agentId, app);
      }

      // Fall back to legacy agents array for backward compatibility
      const legacyContext = workspace.context as LegacyWorkspaceContext | undefined;
      const legacyAgents = legacyContext?.agents;
      if (legacyAgents && Array.isArray(legacyAgents) && legacyAgents.length > 0) {
        const legacyPromptRef = legacyAgents[0];
        if (legacyPromptRef && legacyPromptRef.name) {
          return await this.fetchPromptByNameOrId(legacyPromptRef.name, app);
        }
      }

      return null;

    } catch (error) {
      console.error('[WorkspacePromptResolver] Error fetching prompt:', error);
      return null;
    }
  }

  /**
   * Fetch prompt by name or ID (unified lookup)
   * Uses CustomPromptStorageService for SQLite/data.json lookup
   * @param identifier The prompt name or ID
   * @param app The Obsidian app instance (unused, kept for compatibility)
   * @returns Prompt info or null if not found
   */
  async fetchPromptByNameOrId(
    identifier: string,
    app: App
  ): Promise<WorkspacePromptInfo | null> {
    try {
      // Access CustomPromptStorageService from PromptManagerAgent
      const agentManager = (this.plugin as any).agentManager;
      if (!agentManager) {
        console.error('[WorkspacePromptResolver] AgentManager not available');
        return null;
      }

      const promptManagerAgent = agentManager.getAgent('promptManager');
      if (!promptManagerAgent) {
        console.error('[WorkspacePromptResolver] PromptManager agent not found');
        return null;
      }

      const storageService = promptManagerAgent.getStorageService();
      const prompt = storageService.getPromptByNameOrId(identifier);

      console.error('[WorkspacePromptResolver] getPromptByNameOrId returned:', prompt ? JSON.stringify({ id: prompt.id, name: prompt.name }) : 'null');

      if (!prompt) {
        console.error('[WorkspacePromptResolver] Prompt not found for identifier:', identifier);
        return null;
      }

      return {
        id: prompt.id,
        name: prompt.name,
        systemPrompt: prompt.prompt
      };

    } catch (error) {
      console.error('[WorkspacePromptResolver] Exception in fetchPromptByNameOrId:', error);
      return null;
    }
  }
}
