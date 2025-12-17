/**
 * Location: /src/agents/memoryManager/services/WorkspaceAgentResolver.ts
 * Purpose: Resolves agent information from workspaces
 *
 * This service handles looking up agent data associated with workspaces,
 * supporting both ID-based and unified name/ID lookup with backward
 * compatibility for legacy workspace structures.
 *
 * Used by: LoadWorkspaceMode for resolving workspace agents
 * Integrates with: CustomPromptStorageService via AgentManager
 *
 * Responsibilities:
 * - Resolve workspace agent from dedicatedAgent or legacy agents array
 * - Fetch agent data by ID (for when ID is known)
 * - Fetch agent data by name or ID (unified lookup)
 */

import type { App } from 'obsidian';
import { ProjectWorkspace, WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import type { AgentManager } from '../../../services/AgentManager';
import type { AgentManagerAgent } from '../../agentManager/agentManager';
import type { CustomPromptStorageService } from '../../agentManager/services/CustomPromptStorageService';

/**
 * Agent information returned from resolution operations
 */
export interface AgentInfo {
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
 * AgentManager agent interface with storage service
 */
interface AgentManagerWithStorage {
  storageService: CustomPromptStorageService;
}

/**
 * Service for resolving workspace agents
 * Implements Single Responsibility Principle - only handles agent resolution
 */
export class WorkspaceAgentResolver {
  /**
   * Fetch workspace agent data if available
   * Handles both new dedicatedAgent structure and legacy agents array
   * @param workspace The workspace to fetch agent from
   * @param app The Obsidian app instance
   * @returns Agent info or null if not available
   */
  async fetchWorkspaceAgent(
    workspace: ProjectWorkspace,
    app: App
  ): Promise<AgentInfo | null> {
    try {
      // Check if workspace has a dedicated agent
      if (!workspace.context?.dedicatedAgent) {
        // Fall back to legacy agents array for backward compatibility
        const legacyContext = workspace.context as LegacyWorkspaceContext | undefined;
        const legacyAgents = legacyContext?.agents;
        if (legacyAgents && Array.isArray(legacyAgents) && legacyAgents.length > 0) {
          const legacyAgentRef = legacyAgents[0];
          if (legacyAgentRef && legacyAgentRef.name) {
            return await this.fetchAgentByNameOrId(legacyAgentRef.name, app);
          }
        }
        return null;
      }

      // Use the new dedicated agent structure - use unified lookup
      const { agentId } = workspace.context.dedicatedAgent;
      return await this.fetchAgentByNameOrId(agentId, app);

    } catch (error) {
      return null;
    }
  }

  /**
   * Fetch agent by name or ID (unified lookup)
   * Tries ID first (more specific), then falls back to name
   * @param identifier The agent name or ID
   * @param app The Obsidian app instance
   * @returns Agent info or null if not found
   */
  async fetchAgentByNameOrId(
    identifier: string,
    app: App
  ): Promise<AgentInfo | null> {
    try {
      // Get CustomPromptStorageService through plugin's agentManager
      const plugin = getNexusPlugin(app);
      if (!plugin || !this.hasAgentManager(plugin)) {
        return null;
      }

      const agentManagerAgent = plugin.agentManager.getAgent('agentManager');
      if (!this.isAgentManagerAgent(agentManagerAgent)) {
        return null;
      }

      // Use unified lookup that tries ID first, then name
      const agent = agentManagerAgent.storageService.getPromptByNameOrId(identifier);
      if (!agent) {
        return null;
      }

      return {
        id: agent.id,
        name: agent.name,
        systemPrompt: agent.prompt
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
   * Type guard to check if agent is AgentManagerAgent with storageService
   */
  private isAgentManagerAgent(agent: unknown): agent is AgentManagerWithStorage {
    return typeof agent === 'object' && agent !== null && 'storageService' in agent;
  }
}
