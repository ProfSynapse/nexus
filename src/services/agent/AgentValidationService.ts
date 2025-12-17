/**
 * Location: src/services/agent/AgentValidationService.ts
 *
 * Purpose: Checks if API keys are configured for agent capabilities
 * Extracted from AgentRegistrationService.ts to follow Single Responsibility Principle
 *
 * Used by: AgentRegistrationService for capability validation
 */

import { Plugin } from 'obsidian';
import NexusPlugin from '../../main';
import { DEFAULT_LLM_PROVIDER_SETTINGS } from '../../types';
import { logger } from '../../utils/logger';

/**
 * Service for validating agent capabilities and API keys
 */
export class AgentValidationService {
  constructor(private plugin: Plugin | NexusPlugin) {}

  /**
   * Check if LLM API keys are configured (not validated - validation happens on first use)
   * This enables LLM modes without making network requests on every startup
   */
  async validateLLMApiKeys(): Promise<boolean> {
    try {
      const pluginWithSettings = this.plugin as Plugin & { settings?: { settings?: { llmProviders?: typeof DEFAULT_LLM_PROVIDER_SETTINGS } } };
      const pluginSettings = pluginWithSettings?.settings?.settings;
      const llmProviderSettings = pluginSettings?.llmProviders || DEFAULT_LLM_PROVIDER_SETTINGS;

      const defaultProvider = llmProviderSettings.defaultModel?.provider;
      if (!defaultProvider) {
        return false;
      }

      const providerConfig = llmProviderSettings.providers?.[defaultProvider];
      if (!providerConfig?.apiKey) {
        return false;
      }

      // Just check if an API key is configured - don't validate on startup
      // Validation will happen on first use, providing better UX
      return true;
    } catch (error) {
      logger.systemError(error as Error, 'LLM API Key Check');
      return false;
    }
  }

  /**
   * Get agent capability status
   */
  async getCapabilityStatus(): Promise<{
    hasValidLLMKeys: boolean;
    enableSearchModes: boolean;
    enableLLMModes: boolean;
  }> {
    const hasValidLLMKeys = await this.validateLLMApiKeys();

    // Search modes disabled
    const enableSearchModes = false;

    // Enable LLM-dependent modes only if valid LLM API keys exist
    const enableLLMModes = hasValidLLMKeys;

    return {
      hasValidLLMKeys,
      enableSearchModes,
      enableLLMModes
    };
  }
}
