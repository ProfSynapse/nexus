/**
 * ModelDiscoveryService - Query and aggregate models from all providers
 *
 * Extracted from LLMService.ts to follow Single Responsibility Principle.
 * This service is responsible ONLY for:
 * - Querying available models from each provider
 * - Aggregating models across all providers
 * - Adding provider metadata to model information
 * - Finding specific models across providers
 */

import { ModelInfo } from '../adapters/types';
import { LLMProviderSettings } from '../../../types';
import { IAdapterRegistry } from './AdapterRegistry';

/**
 * Model information with provider context
 */
export interface ModelWithProvider extends ModelInfo {
  provider: string;
  userDescription?: string;
}

/**
 * Interface for model discovery operations
 */
export interface IModelDiscoveryService {
  /**
   * Get all available models from enabled providers
   */
  getAvailableModels(): Promise<ModelWithProvider[]>;

  /**
   * Get models for a specific provider
   */
  getModelsForProvider(providerId: string): Promise<ModelInfo[]>;

  /**
   * Find a model by ID across all providers
   */
  findModel(modelId: string): Promise<ModelWithProvider | null>;
}

/**
 * ModelDiscoveryService implementation
 * Queries and aggregates models from all configured LLM providers
 */
export class ModelDiscoveryService implements IModelDiscoveryService {
  constructor(
    private adapterRegistry: IAdapterRegistry,
    private settings: LLMProviderSettings
  ) {}

  /**
   * Get all available models from enabled providers
   * Queries each provider in parallel for better performance
   */
  async getAvailableModels(): Promise<ModelWithProvider[]> {
    const allModels: ModelWithProvider[] = [];
    const availableProviders = this.adapterRegistry.getAvailableProviders();

    // Query all providers in parallel using Promise.allSettled
    // This ensures one provider failure doesn't block others
    await Promise.allSettled(
      availableProviders.map(async (providerId) => {
        const adapter = this.adapterRegistry.getAdapter(providerId);
        if (!adapter) return;

        try {
          const models = await adapter.listModels();

          // Add provider information and user description to each model
          const modelsWithProvider = models.map(model => ({
            ...model,
            provider: providerId,
            userDescription: this.settings.providers[providerId]?.userDescription
          }));

          allModels.push(...modelsWithProvider);
        } catch (error) {
        }
      })
    );

    return allModels;
  }

  /**
   * Get models for a specific provider
   * @throws Error if provider is not available
   */
  async getModelsForProvider(providerId: string): Promise<ModelInfo[]> {
    const adapter = this.adapterRegistry.getAdapter(providerId);

    if (!adapter) {
      throw new Error(`Provider ${providerId} not available`);
    }

    try {
      return await adapter.listModels();
    } catch (error) {
      console.error(`ModelDiscoveryService: Failed to get models from ${providerId}:`, error);
      throw error;
    }
  }

  /**
   * Find a model by ID across all providers
   * Returns null if model is not found
   */
  async findModel(modelId: string): Promise<ModelWithProvider | null> {
    const allModels = await this.getAvailableModels();
    return allModels.find(m => m.id === modelId) || null;
  }

  /**
   * Update settings (for when settings change)
   * Creates a new instance with updated settings
   */
  static create(adapterRegistry: IAdapterRegistry, settings: LLMProviderSettings): ModelDiscoveryService {
    return new ModelDiscoveryService(adapterRegistry, settings);
  }
}
