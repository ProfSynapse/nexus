/**
 * List Models Tool
 * Lists available LLM models grouped by provider
 */

import { BaseTool } from '../../baseTool';
import { CommonResult, CommonParameters } from '../../../types';
import { createResult } from '../../../utils/schemaUtils';
import { LLMProviderManager } from '../../../services/llm/providers/ProviderManager';

export interface ListModelsParams extends CommonParameters {
  // No additional parameters
}

export interface ListModelsResult extends CommonResult {
  data: {
    providers: Array<{
      provider: string;
      models: string[];
    }>;
    default: {
      provider: string;
      model: string;
    };
  };
}

export class ListModelsTool extends BaseTool<ListModelsParams, ListModelsResult> {
  private readonly providerManager: LLMProviderManager;

  constructor(providerManager: LLMProviderManager) {
    super(
      'listModels',
      'List Available Models',
      'List available LLM models grouped by provider',
      '2.0.0'
    );
    this.providerManager = providerManager;
  }

  async execute(params: ListModelsParams): Promise<ListModelsResult> {
    try {
      const models = await this.providerManager.getAvailableModels();
      const settings = this.providerManager.getSettings();

      // Group models by provider
      const providerMap = new Map<string, string[]>();
      for (const model of models) {
        const existing = providerMap.get(model.provider) || [];
        existing.push(model.id);
        providerMap.set(model.provider, existing);
      }

      // Convert to array format
      const providers = Array.from(providerMap.entries()).map(([provider, modelIds]) => ({
        provider,
        models: modelIds
      }));

      return createResult<ListModelsResult>(true, {
        providers,
        default: {
          provider: settings.defaultModel.provider,
          model: settings.defaultModel.model
        }
      });

    } catch (error) {
      return createResult<ListModelsResult>(
        false,
        undefined,
        `Failed to list models: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  getParameterSchema(): Record<string, unknown> {
    const toolSchema = {
      type: 'object',
      properties: {},
      required: []
    };
    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        error: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            providers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  provider: { type: 'string' },
                  models: { type: 'array', items: { type: 'string' } }
                },
                required: ['provider', 'models']
              }
            },
            default: {
              type: 'object',
              properties: {
                provider: { type: 'string' },
                model: { type: 'string' }
              },
              required: ['provider', 'model']
            }
          },
          required: ['providers', 'default']
        }
      },
      required: ['success']
    };
  }
}
