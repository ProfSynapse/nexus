/**
 * Location: /src/ui/chat/utils/AgentConfigurationUtility.ts
 *
 * Purpose: Utility for agent discovery and configuration
 * Extracted from ModelAgentManager.ts to follow Single Responsibility Principle
 *
 * Used by: ModelAgentManager for agent-related operations
 * Dependencies: AgentDiscoveryService
 */

import { AgentOption } from '../types/SelectionTypes';
import { AgentDiscoveryService, AgentInfo } from '../../../services/agent/AgentDiscoveryService';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import type { App } from 'obsidian';
import type NexusPlugin from '../../../main';

/**
 * Utility class for agent configuration and discovery
 */
export class AgentConfigurationUtility {
  private static agentDiscoveryService: AgentDiscoveryService | null = null;

  /**
   * Initialize agent discovery service
   */
  static async initializeDiscoveryService(app: App): Promise<AgentDiscoveryService | null> {
    if (AgentConfigurationUtility.agentDiscoveryService) {
      return AgentConfigurationUtility.agentDiscoveryService;
    }

    try {
      const plugin = getNexusPlugin<NexusPlugin>(app);
      if (!plugin) {
        return null;
      }

      const customPromptStorageService = await plugin.getService('customPromptStorageService');
      if (!customPromptStorageService) {
        return null;
      }

      AgentConfigurationUtility.agentDiscoveryService = new AgentDiscoveryService(customPromptStorageService);
      return AgentConfigurationUtility.agentDiscoveryService;
    } catch (error) {
      console.error('[AgentConfigurationUtility] Failed to initialize discovery service:', error);
      return null;
    }
  }

  /**
   * Get available agents from agent manager
   */
  static async getAvailableAgents(app: App): Promise<AgentOption[]> {
    try {
      // Initialize AgentDiscoveryService if needed
      const discoveryService = await AgentConfigurationUtility.initializeDiscoveryService(app);
      if (!discoveryService) {
        return [];
      }

      // Get enabled agents from discovery service
      const agents = await discoveryService.getEnabledAgents();

      // Convert to AgentOption format
      return agents.map(agent => AgentConfigurationUtility.mapToAgentOption(agent));
    } catch (error) {
      console.error('[AgentConfigurationUtility] Failed to get available agents:', error);
      return [];
    }
  }

  /**
   * Convert AgentInfo to AgentOption format
   */
  static mapToAgentOption(agent: AgentInfo): AgentOption {
    return {
      id: agent.id,
      name: agent.name || 'Unnamed Agent',
      description: agent.description || 'Custom agent prompt',
      systemPrompt: agent.prompt
    };
  }

  /**
   * Reset discovery service (for testing or reinitialization)
   */
  static resetDiscoveryService(): void {
    AgentConfigurationUtility.agentDiscoveryService = null;
  }
}
