/**
 * Location: /src/ui/chat/utils/PromptConfigurationUtility.ts
 *
 * Purpose: Utility for custom prompt discovery and configuration
 * Extracted from ModelAgentManager.ts to follow Single Responsibility Principle
 *
 * Used by: ModelAgentManager for prompt-related operations
 * Dependencies: PromptDiscoveryService
 */

import { PromptOption } from '../types/SelectionTypes';
import { PromptDiscoveryService, PromptInfo } from '../../../services/agent/PromptDiscoveryService';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import type { App } from 'obsidian';
import type NexusPlugin from '../../../main';

/**
 * Utility class for prompt configuration and discovery
 */
export class PromptConfigurationUtility {
  private static promptDiscoveryService: PromptDiscoveryService | null = null;

  /**
   * Initialize prompt discovery service
   */
  static async initializeDiscoveryService(app: App): Promise<PromptDiscoveryService | null> {
    if (PromptConfigurationUtility.promptDiscoveryService) {
      return PromptConfigurationUtility.promptDiscoveryService;
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

      PromptConfigurationUtility.promptDiscoveryService = new PromptDiscoveryService(customPromptStorageService);
      return PromptConfigurationUtility.promptDiscoveryService;
    } catch (error) {
      console.error('[PromptConfigurationUtility] Failed to initialize discovery service:', error);
      return null;
    }
  }

  /**
   * Get available prompts from prompt manager
   */
  static async getAvailablePrompts(app: App): Promise<PromptOption[]> {
    try {
      // Initialize PromptDiscoveryService if needed
      const discoveryService = await PromptConfigurationUtility.initializeDiscoveryService(app);
      if (!discoveryService) {
        return [];
      }

      // Get enabled prompts from discovery service
      const prompts = await discoveryService.getEnabledPrompts();

      // Convert to PromptOption format
      return prompts.map(prompt => PromptConfigurationUtility.mapToPromptOption(prompt));
    } catch (error) {
      console.error('[PromptConfigurationUtility] Failed to get available prompts:', error);
      return [];
    }
  }

  /**
   * Convert PromptInfo to PromptOption format
   */
  static mapToPromptOption(promptData: PromptInfo): PromptOption {
    return {
      id: promptData.id,
      name: promptData.name || 'Unnamed Prompt',
      description: promptData.description || 'Custom prompt',
      systemPrompt: promptData.prompt
    };
  }

  /**
   * Reset discovery service (for testing or reinitialization)
   */
  static resetDiscoveryService(): void {
    PromptConfigurationUtility.promptDiscoveryService = null;
  }
}
