/**
 * ProviderInfoService - Handles LLM provider and model information retrieval
 * Location: /src/utils/schemas/services/ProviderInfoService.ts
 *
 * This service provides methods for retrieving provider and model information
 * from the LLMProviderManager for use in schema generation.
 *
 * Used by: SchemaBuilder and concrete builder implementations
 */

import { LLMProviderManager } from '../../../services/llm/providers/ProviderManager';
import { StaticModelsService } from '../../../services/StaticModelsService';
import { ProviderInfo } from '../SchemaTypes';

/**
 * Service for retrieving LLM provider and model information
 */
export class ProviderInfoService {
  constructor(private providerManager: LLMProviderManager | null) {}

  /**
   * Get comprehensive provider information for schema building
   */
  getProviderInfo(): ProviderInfo {
    if (!this.providerManager) {
      return {
        enabledProviders: [],
        availableModels: [],
        hasProviderManager: false
      };
    }

    return {
      enabledProviders: this.getEnabledProviders(),
      availableModels: this.getAvailableModels(),
      hasProviderManager: true
    };
  }

  /**
   * Get list of enabled providers from provider manager
   */
  getEnabledProviders(): string[] {
    if (!this.providerManager) return [];

    try {
      const settings = this.providerManager.getSettings();
      return Object.keys(settings.providers)
        .filter(id => settings.providers[id]?.enabled && settings.providers[id]?.apiKey);
    } catch (error) {
      return [];
    }
  }

  /**
   * Get list of available models from enabled providers
   */
  getAvailableModels(): string[] {
    if (!this.providerManager) return [];

    try {
      const staticModelsService = StaticModelsService.getInstance();
      const enabledProviders = this.getEnabledProviders();
      const models: string[] = [];

      enabledProviders.forEach(providerId => {
        try {
          const providerModels = staticModelsService.getModelsForProvider(providerId);
          models.push(...providerModels.map((m: any) => m.id));
        } catch (error) {
        }
      });

      return [...new Set(models)]; // Remove duplicates
    } catch (error) {
      return [];
    }
  }

  /**
   * Get default model from provider manager settings
   */
  getDefaultModel(): { provider: string; model: string } | null {
    if (!this.providerManager) return null;

    try {
      const settings = this.providerManager.getSettings();
      return settings.defaultModel || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Update the provider manager instance
   */
  updateProviderManager(providerManager: LLMProviderManager | null): void {
    this.providerManager = providerManager;
  }
}
