/**
 * List Models Tool
 * Lists available LLM models from enabled providers with capabilities and pricing
 */

import { BaseTool } from '../../baseTool';
import { CommonResult, CommonParameters } from '../../../types';
import { createResult, getCommonResultSchema } from '../../../utils/schemaUtils';
// Import removed - using this.getMergedSchema() instead of mergeWithCommonSchema
import { LLMProviderManager } from '../../../services/llm/providers/ProviderManager';

export interface ListModelsParams extends CommonParameters {
  // No additional parameters beyond common ones
}

export interface ListModelsResult extends CommonResult {
  data: {
    models: Array<{
      provider: string;
      model: string;
      displayName: string;
      userDescription?: string;
      isDefault: boolean;
      capabilities: {
        contextWindow: number;
        maxOutputTokens?: number;
        supportsJSON: boolean;
        supportsImages: boolean;
        supportsFunctions: boolean;
        supportsStreaming: boolean;
        supportsThinking?: boolean;
      };
      pricing: {
        inputPerMillion: number;
        outputPerMillion: number;
        currency: string;
        lastUpdated: string;
      };
    }>;
    defaultModel: {
      provider: string;
      model: string;
    };
    statistics: {
      totalModels: number;
      providerCount: number;
      averageContextWindow: number;
      maxContextWindow: number;
      minCostPerMillion: number;
      maxCostPerMillion: number;
    };
    availableProviders: Array<{
      id: string;
      name: string;
      description: string;
      isEnabled: boolean;
      userDescription?: string;
      modelCount: number;
      specialFeatures?: string[];
    }>;
  };
}

export class ListModelsTool extends BaseTool<ListModelsParams, ListModelsResult> {
  private readonly providerManager: LLMProviderManager;

  constructor(providerManager: LLMProviderManager) {
    super(
      'listModels',
      'List Available Models',
      'List all available LLM models from enabled providers with capabilities, pricing, and statistics',
      '1.0.0'
    );
    this.providerManager = providerManager;
  }


  /**
   * Execute the list models tool
   */
  async execute(params: ListModelsParams): Promise<ListModelsResult> {
    try {

      // Get all available models
      const models = await this.providerManager.getAvailableModels();
      
      // Get provider information
      const enabledProviders = this.providerManager.getEnabledProviders();
      
      // Get default model from settings
      const settings = this.providerManager.getSettings();
      const defaultModel = {
        provider: settings.defaultModel.provider,
        model: settings.defaultModel.model
      };

      // Group models by provider for counting
      const modelsByProvider = models.reduce((acc, model) => {
        acc[model.provider] = (acc[model.provider] || 0) + 1;
        return acc;
      }, {} as { [key: string]: number });

      // Calculate statistics with safe pricing access
      const modelsWithPricing = models.filter(m => m.pricing && typeof m.pricing.inputPerMillion === 'number');
      const statistics = {
        totalModels: models.length,
        providerCount: enabledProviders.length,
        averageContextWindow: models.length > 0 ? Math.round(models.reduce((sum, m) => sum + m.contextWindow, 0) / models.length) : 0,
        maxContextWindow: models.length > 0 ? Math.max(...models.map(m => m.contextWindow)) : 0,
        minCostPerMillion: modelsWithPricing.length > 0 ? Math.min(...modelsWithPricing.map(m => m.pricing.inputPerMillion)) : 0,
        maxCostPerMillion: modelsWithPricing.length > 0 ? Math.max(...modelsWithPricing.map(m => m.pricing.inputPerMillion)) : 0
      };

      // Format the response
      const formattedModels = models.map(model => ({
        provider: model.provider,
        model: model.id,
        displayName: model.name,
        userDescription: model.userDescription,
        isDefault: model.isDefault || false,
        capabilities: {
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          supportsJSON: model.supportsJSON,
          supportsImages: model.supportsImages,
          supportsFunctions: model.supportsFunctions,
          supportsStreaming: model.supportsStreaming,
          supportsThinking: model.supportsThinking
        },
        pricing: {
          inputPerMillion: model.pricing?.inputPerMillion ?? 0,
          outputPerMillion: model.pricing?.outputPerMillion ?? 0,
          currency: model.pricing?.currency ?? 'USD',
          lastUpdated: model.pricing?.lastUpdated ?? new Date().toISOString()
        }
      }));

      // Format provider information
      const availableProviders = enabledProviders.map(provider => {
        const baseInfo = {
          id: provider.id,
          name: provider.name,
          description: provider.description,
          isEnabled: provider.isEnabled,
          userDescription: provider.userDescription,
          modelCount: modelsByProvider[provider.id] || 0
        };
        
        // Add special features for OpenRouter
        if (provider.id === 'openrouter') {
          return {
            ...baseInfo,
            specialFeatures: [
              'Add ":online" to any model name for web-enabled responses (e.g., "gpt-4:online")'
            ]
          };
        }
        
        return baseInfo;
      });

      const resultData = {
        models: formattedModels,
        defaultModel,
        statistics,
        availableProviders
      };

      return createResult<ListModelsResult>(
        true,
        resultData,
        undefined,
        undefined,
        undefined,
        params.context.sessionId,
        params.context
      );

    } catch (error) {
      return createResult<ListModelsResult>(
        false,
        undefined,
        `Failed to list models: ${error instanceof Error ? error.message : 'Unknown error'}`,
        undefined,
        undefined,
        params.context.sessionId,
        params.context
      );
    }
  }

  /**
   * Get parameter schema for the tool
   */
  getParameterSchema(): any {
    const toolSchema = {
      type: 'object',
      properties: {
        // No additional parameters beyond common ones
      },
      required: []
    };
    
    return this.getMergedSchema(toolSchema);
  }

  /**
   * Get result schema for the tool
   */
  getResultSchema(): any {
    const commonSchema = getCommonResultSchema();

    // Override the data property to define the specific structure for this tool
    return {
      ...commonSchema,
      properties: {
        ...commonSchema.properties,
        data: {
          type: 'object',
          properties: {
            models: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  provider: { type: 'string' },
                  model: { type: 'string' },
                  displayName: { type: 'string' },
                  userDescription: { type: 'string' },
                  isDefault: { type: 'boolean' },
                  capabilities: {
                    type: 'object',
                    properties: {
                      contextWindow: { type: 'number' },
                      maxOutputTokens: { type: 'number' },
                      supportsJSON: { type: 'boolean' },
                      supportsImages: { type: 'boolean' },
                      supportsFunctions: { type: 'boolean' },
                      supportsStreaming: { type: 'boolean' },
                      supportsThinking: { type: 'boolean' }
                    },
                    required: ['contextWindow', 'supportsJSON', 'supportsImages', 'supportsFunctions', 'supportsStreaming']
                  },
                  pricing: {
                    type: 'object',
                    properties: {
                      inputPerMillion: { type: 'number' },
                      outputPerMillion: { type: 'number' },
                      currency: { type: 'string' },
                      lastUpdated: { type: 'string' }
                    },
                    required: ['inputPerMillion', 'outputPerMillion', 'currency', 'lastUpdated']
                  }
                },
                required: ['provider', 'model', 'displayName', 'isDefault', 'capabilities', 'pricing']
              }
            },
            defaultModel: {
              type: 'object',
              properties: {
                provider: { type: 'string' },
                model: { type: 'string' }
              },
              required: ['provider', 'model']
            },
            statistics: {
              type: 'object',
              properties: {
                totalModels: { type: 'number' },
                providerCount: { type: 'number' },
                averageContextWindow: { type: 'number' },
                maxContextWindow: { type: 'number' },
                minCostPerMillion: { type: 'number' },
                maxCostPerMillion: { type: 'number' }
              },
              required: ['totalModels', 'providerCount', 'averageContextWindow', 'maxContextWindow', 'minCostPerMillion', 'maxCostPerMillion']
            },
            availableProviders: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  isEnabled: { type: 'boolean' },
                  userDescription: { type: 'string' },
                  modelCount: { type: 'number' },
                  specialFeatures: {
                    type: 'array',
                    items: { type: 'string' }
                  }
                },
                required: ['id', 'name', 'description', 'isEnabled', 'modelCount']
              }
            }
          },
          required: ['models', 'defaultModel', 'statistics', 'availableProviders']
        }
      }
    };
  }
}