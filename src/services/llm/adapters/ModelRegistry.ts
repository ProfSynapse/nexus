/**
 * Centralized AI Model Registry
 * 
 * This file imports all provider-specific model definitions and provides
 * a unified interface for working with models across all providers.
 * 
 * Updated June 17, 2025 with modular provider structure
 */

import { ModelSpec } from './modelTypes';
import { OPENAI_MODELS, OPENAI_DEFAULT_MODEL } from './openai/OpenAIModels';
import { GOOGLE_MODELS, GOOGLE_DEFAULT_MODEL } from './google/GoogleModels';
import { ANTHROPIC_MODELS, ANTHROPIC_DEFAULT_MODEL } from './anthropic/AnthropicModels';
import { MISTRAL_MODELS, MISTRAL_DEFAULT_MODEL } from './mistral/MistralModels';
import { OPENROUTER_MODELS, OPENROUTER_DEFAULT_MODEL } from './openrouter/OpenRouterModels';
import { REQUESTY_MODELS, REQUESTY_DEFAULT_MODEL } from './requesty/RequestyModels';
import { GROQ_MODELS, GROQ_DEFAULT_MODEL } from './groq/GroqModels';
import { OPENAI_CODEX_MODELS, OPENAI_CODEX_DEFAULT_MODEL } from './openai-codex/OpenAICodexModels';
import type { LLMProviderSettings } from '../../../types';

// Re-export ModelSpec for convenience
export type { ModelSpec };

/**
 * Complete model registry organized by provider
 * Reconstructed from individual provider model definitions
 * Note: Ollama models are dynamically generated based on user configuration
 */
export const AI_MODELS: Record<string, ModelSpec[]> = {
  openai: OPENAI_MODELS,
  'openai-codex': OPENAI_CODEX_MODELS,
  google: GOOGLE_MODELS,
  anthropic: ANTHROPIC_MODELS,
  mistral: MISTRAL_MODELS,
  openrouter: OPENROUTER_MODELS,
  requesty: REQUESTY_MODELS,
  groq: GROQ_MODELS
};

/**
 * Helper functions for working with the model registry
 */
export class ModelRegistry {
  /**
   * Get all models for a specific provider
   * For Ollama, returns user-configured model dynamically
   * For LM Studio, returns empty array (models discovered via adapter.listModels())
   */
  static getProviderModels(provider: string, settings?: LLMProviderSettings): ModelSpec[] {
    // Special handling for Ollama - user-configured models only
    if (provider === 'ollama') {
      const ollamaModel = settings?.providers?.ollama?.ollamaModel;

      if (!ollamaModel || !ollamaModel.trim()) {
        return []; // No models if not configured
      }

      // Create dynamic ModelSpec for user's configured model
      return [{
        provider: 'ollama',
        name: ollamaModel,
        apiName: ollamaModel,
        contextWindow: 128000, // Fixed reasonable default
        maxTokens: 4096,
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        capabilities: {
          supportsJSON: false,
          supportsImages: ollamaModel.includes('vision') || ollamaModel.includes('llava'),
          supportsFunctions: false,
          supportsStreaming: true,
          supportsThinking: false
        }
      }];
    }

    // Special handling for LM Studio - models discovered dynamically
    // Return empty array here; models will be loaded via adapter.listModels()
    if (provider === 'lmstudio') {
      return [];
    }

    // Special handling for WebLLM - local models with $0 cost
    if (provider === 'webllm') {
      return [{
        provider: 'webllm',
        name: 'Nexus 7B',
        apiName: 'nexus-tools-q4f16',
        contextWindow: 32768,
        maxTokens: 4096,
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        capabilities: {
          supportsJSON: true,
          supportsImages: false,
          supportsFunctions: true,
          supportsStreaming: true,
          supportsThinking: false
        }
      }];
    }

    // Standard behavior for other providers
    return AI_MODELS[provider] || [];
  }

  /**
   * Find a specific model by provider and API name
   * For OpenRouter, supports :online suffix (e.g., "gpt-4:online")
   * For Anthropic, supports :1m suffix for 1M context variants (e.g., "claude-sonnet-4-5-20250929:1m")
   */
  static findModel(provider: string, apiName: string): ModelSpec | undefined {
    const providerModels = this.getProviderModels(provider);

    // For OpenRouter models, check if apiName has :online suffix
    if (provider === 'openrouter' && apiName.endsWith(':online')) {
      const baseModelName = apiName.replace(':online', '');
      return providerModels.find(model => model.apiName === baseModelName);
    }

    // For Anthropic models, check if apiName has :1m suffix
    // The :1m suffix indicates 1M context variant, which shares the same apiName
    // but has different contextWindow and betaHeaders
    if (provider === 'anthropic' && apiName.endsWith(':1m')) {
      const baseModelName = apiName.replace(':1m', '');
      return providerModels.find(model =>
        model.apiName === baseModelName && model.contextWindow >= 1000000
      );
    }

    return providerModels.find(model => model.apiName === apiName);
  }

  /**
   * Get all available providers
   */
  static getProviders(): string[] {
    return Object.keys(AI_MODELS);
  }

  /**
   * Get models with specific capabilities
   */
  static getModelsByCapability(capability: keyof ModelSpec['capabilities'], value = true): ModelSpec[] {
    const allModels = Object.values(AI_MODELS).flat();
    return allModels.filter(model => model.capabilities[capability] === value);
  }

  /**
   * Get models within a cost range (input cost per million tokens)
   */
  static getModelsByCostRange(maxInputCost: number, maxOutputCost?: number): ModelSpec[] {
    const allModels = Object.values(AI_MODELS).flat();
    return allModels.filter(model => {
      const withinInputCost = model.inputCostPerMillion <= maxInputCost;
      const withinOutputCost = maxOutputCost ? model.outputCostPerMillion <= maxOutputCost : true;
      return withinInputCost && withinOutputCost;
    });
  }

  /**
   * Get the latest models (all current models)
   */
  static getLatestModels(): ModelSpec[] {
    return Object.values(AI_MODELS).flat();
  }

  /**
   * Check if a model name is valid for OpenRouter with :online suffix
   */
  static isValidOpenRouterModel(apiName: string): boolean {
    if (!apiName.endsWith(':online')) {
      return this.findModel('openrouter', apiName) !== undefined;
    }
    
    const baseModelName = apiName.replace(':online', '');
    return this.findModel('openrouter', baseModelName) !== undefined;
  }

  /**
   * Convert ModelSpec to the legacy ModelInfo format
   */
  static toModelInfo(modelSpec: ModelSpec): any {
    return {
      id: modelSpec.apiName,
      name: modelSpec.name,
      contextWindow: modelSpec.contextWindow,
      maxOutputTokens: modelSpec.maxTokens,
      supportsJSON: modelSpec.capabilities.supportsJSON,
      supportsImages: modelSpec.capabilities.supportsImages,
      supportsFunctions: modelSpec.capabilities.supportsFunctions,
      supportsStreaming: modelSpec.capabilities.supportsStreaming,
      supportsThinking: modelSpec.capabilities.supportsThinking,
      costPer1kTokens: {
        input: modelSpec.inputCostPerMillion / 1000,
        output: modelSpec.outputCostPerMillion / 1000
      },
      pricing: {
        inputPerMillion: modelSpec.inputCostPerMillion,
        outputPerMillion: modelSpec.outputCostPerMillion,
        currency: 'USD',
        lastUpdated: new Date().toISOString()
      }
    };
  }
}

/**
 * Export default models for each provider (recommended models)
 */
export const DEFAULT_MODELS: Record<string, string> = {
  openai: OPENAI_DEFAULT_MODEL,
  'openai-codex': OPENAI_CODEX_DEFAULT_MODEL,
  google: GOOGLE_DEFAULT_MODEL,
  anthropic: ANTHROPIC_DEFAULT_MODEL,
  mistral: MISTRAL_DEFAULT_MODEL,
  openrouter: OPENROUTER_DEFAULT_MODEL,
  requesty: REQUESTY_DEFAULT_MODEL,
  groq: GROQ_DEFAULT_MODEL
};