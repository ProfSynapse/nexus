/**
 * Static Model Helpers
 * Location: src/services/llm/adapters/shared/StaticModelHelpers.ts
 *
 * Shared listModels/getModelPricing helpers for adapters whose model catalogs
 * are static ModelSpec arrays (Groq, Mistral, Anthropic, Google) or live in
 * the central ModelRegistry (OpenAI, OpenRouter). Extracted from per-adapter
 * copies; behavior-preserving.
 */
import { ModelSpec } from '../modelTypes';
import { ModelInfo, ModelPricing } from '../types';
import { ModelRegistry } from '../ModelRegistry';

export type StaticModelInfo = ModelInfo & {
  costPer1kTokens: { input: number; output: number };
};

/**
 * Map a static ModelSpec onto the ModelInfo shape returned by listModels.
 * Capability flags (including supportsThinking) come from the spec; callers
 * that need to override fields (e.g. Groq forcing supportsThinking: false,
 * Anthropic suffixing :1m ids) spread over the result.
 */
export function staticModelToModelInfo(model: ModelSpec): StaticModelInfo {
  return {
    id: model.apiName,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    supportsJSON: model.capabilities.supportsJSON,
    supportsImages: model.capabilities.supportsImages,
    supportsFunctions: model.capabilities.supportsFunctions,
    supportsStreaming: model.capabilities.supportsStreaming,
    supportsThinking: model.capabilities.supportsThinking,
    costPer1kTokens: {
      input: model.inputCostPerMillion / 1000,
      output: model.outputCostPerMillion / 1000
    },
    pricing: {
      inputPerMillion: model.inputCostPerMillion,
      outputPerMillion: model.outputCostPerMillion,
      currency: 'USD',
      lastUpdated: new Date().toISOString()
    }
  };
}

/**
 * Look up pricing for a model in a static ModelSpec array.
 */
export function getStaticModelPricing(models: ModelSpec[], modelId: string): ModelPricing | null {
  const model = models.find(m => m.apiName === modelId);
  if (!model) return null;

  return {
    rateInputPerMillion: model.inputCostPerMillion,
    rateOutputPerMillion: model.outputCostPerMillion,
    currency: 'USD'
  };
}

/**
 * Look up pricing for a model in the central ModelRegistry.
 */
export function getRegistryModelPricing(provider: string, modelId: string): ModelPricing | null {
  try {
    const models = ModelRegistry.getProviderModels(provider);
    const model = models.find(m => m.apiName === modelId);
    if (!model) {
      return null;
    }

    return {
      rateInputPerMillion: model.inputCostPerMillion,
      rateOutputPerMillion: model.outputCostPerMillion,
      currency: 'USD'
    };
  } catch {
    return null;
  }
}
