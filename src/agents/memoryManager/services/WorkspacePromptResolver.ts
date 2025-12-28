/**
 * Location: /src/agents/memoryManager/services/WorkspacePromptResolver.ts
 * Purpose: Resolves custom prompt information from workspaces
 *
 * This service handles looking up custom prompt data associated with workspaces,
 * supporting both ID-based and unified name/ID lookup with backward
 * compatibility for legacy workspace structures.
 *
 * Used by: LoadWorkspaceMode for resolving workspace prompts
 * Integrates with: CustomPromptStorageService via AgentManager
 *
 * Responsibilities:
 * - Resolve workspace prompt from dedicatedAgent or legacy agents array
 * - Fetch prompt data by ID (for when ID is known)
 * - Fetch prompt data by name or ID (unified lookup)
 */

import type { App } from 'obsidian';
import { ProjectWorkspace, WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import type { AgentManager } from '../../../services/AgentManager';
import type { PromptManagerAgent } from '../../promptManager/promptManager';
import type { CustomPromptStorageService } from '../../promptManager/services/CustomPromptStorageService';

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
 * Plugin interface with agentManager property
 */
interface NexusPluginWithAgentManager {
  agentManager: AgentManager;
}

/**
 * PromptManager agent interface with storage service
 */
interface PromptManagerWithStorage {
  storageService: CustomPromptStorageService;
}

/**
 * Service for resolving workspace prompts (custom prompts associated with workspaces)
 * Implements Single Responsibility Principle - only handles prompt resolution
 */
export class WorkspacePromptResolver {
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
      // Check if workspace has a dedicated prompt (stored as dedicatedAgent for backward compat)
      if (!workspace.context?.dedicatedAgent) {
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
      }

      // Use the dedicated prompt structure - use unified lookup
      const { agentId } = workspace.context.dedicatedAgent;
      return await this.fetchPromptByNameOrId(agentId, app);

    } catch (error) {
      return null;
    }
  }

  /**
   * Fetch prompt by name or ID (unified lookup)
   * Tries ID first (more specific), then falls back to name
   * @param identifier The prompt name or ID
   * @param app The Obsidian app instance
   * @returns Prompt info or null if not found
   */
  async fetchPromptByNameOrId(
    identifier: string,
    app: App
  ): Promise<WorkspacePromptInfo | null> {
    try {
      // Get CustomPromptStorageService through plugin's agentManager
      const plugin = getNexusPlugin(app);
      if (!plugin || !this.hasAgentManager(plugin)) {
        return null;
      }

      const promptManagerAgent = plugin.agentManager.getAgent('promptManager');
      if (!this.isPromptManagerAgent(promptManagerAgent)) {
        return null;
      }

      // Use unified lookup that tries ID first, then name
      const prompt = promptManagerAgent.storageService.getPromptByNameOrId(identifier);
      if (!prompt) {
        return null;
      }

      return {
        id: prompt.id,
        name: prompt.name,
        systemPrompt: prompt.prompt
      };

    } catch (error) {
      return null;
    }
  }

  /**
   * Type guard to check if plugin has agentManager property
   */
  private hasAgentManager(plugin: unknown): plugin is NexusPluginWithAgentManager {
    return typeof plugin === 'object' && plugin !== null && 'agentManager' in plugin;
  }

  /**
   * Type guard to check if agent is PromptManagerAgent with storageService
   */
  private isPromptManagerAgent(agent: unknown): agent is PromptManagerWithStorage {
    return typeof agent === 'object' && agent !== null && 'storageService' in agent;
  }
}
