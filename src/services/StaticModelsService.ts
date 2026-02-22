/**
 * Static Models Service
 * Loads model information from static adapter files instead of making API calls
 */

import { ModelSpec } from './llm/adapters/modelTypes';
import { OPENAI_MODELS } from './llm/adapters/openai/OpenAIModels';
import { ANTHROPIC_MODELS } from './llm/adapters/anthropic/AnthropicModels';
import { GOOGLE_MODELS } from './llm/adapters/google/GoogleModels';
import { MISTRAL_MODELS } from './llm/adapters/mistral/MistralModels';
import { GROQ_MODELS } from './llm/adapters/groq/GroqModels';
import { OPENROUTER_MODELS } from './llm/adapters/openrouter/OpenRouterModels';
import { REQUESTY_MODELS } from './llm/adapters/requesty/RequestyModels';
import { PERPLEXITY_MODELS } from './llm/adapters/perplexity/PerplexityModels';
import { OPENAI_CODEX_MODELS } from './llm/adapters/openai-codex/OpenAICodexModels';

export interface ModelWithProvider {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  pricing: {
    inputPerMillion: number;
    outputPerMillion: number;
    currency: string;
  };
  capabilities: {
    supportsJSON: boolean;
    supportsImages: boolean;
    supportsFunctions: boolean;
    supportsStreaming: boolean;
    supportsThinking: boolean;
  };
  userDescription?: string; // User-defined description
  isDefault?: boolean;
}

export class StaticModelsService {
  private static instance: StaticModelsService;
  private modelCache: Map<string, ModelWithProvider[]> = new Map();

  /**
   * Get singleton instance
   */
  static getInstance(): StaticModelsService {
    if (!StaticModelsService.instance) {
      StaticModelsService.instance = new StaticModelsService();
    }
    return StaticModelsService.instance;
  }

  /**
   * Get all models for all providers
   */
  getAllModels(): ModelWithProvider[] {
    const allModels: ModelWithProvider[] = [];
    
    const providerModels = [
      { provider: 'openai', models: OPENAI_MODELS },
      { provider: 'anthropic', models: ANTHROPIC_MODELS },
      { provider: 'google', models: GOOGLE_MODELS },
      { provider: 'mistral', models: MISTRAL_MODELS },
      { provider: 'groq', models: GROQ_MODELS },
      { provider: 'openrouter', models: OPENROUTER_MODELS },
      { provider: 'requesty', models: REQUESTY_MODELS },
      { provider: 'perplexity', models: PERPLEXITY_MODELS },
      { provider: 'openai-codex', models: OPENAI_CODEX_MODELS }
    ];

    providerModels.forEach(({ provider, models }) => {
      models.forEach(model => {
        allModels.push(this.convertModelSpec(model));
      });
    });

    return allModels;
  }

  /**
   * Get models for a specific provider
   */
  getModelsForProvider(providerId: string): ModelWithProvider[] {
    if (this.modelCache.has(providerId)) {
      return this.modelCache.get(providerId)!;
    }

    let providerModels: ModelSpec[] = [];
    
    switch (providerId) {
      case 'openai':
        providerModels = OPENAI_MODELS;
        break;
      case 'anthropic':
        providerModels = ANTHROPIC_MODELS;
        break;
      case 'google':
        providerModels = GOOGLE_MODELS;
        break;
      case 'mistral':
        providerModels = MISTRAL_MODELS;
        break;
      case 'groq':
        providerModels = GROQ_MODELS;
        break;
      case 'openrouter':
        providerModels = OPENROUTER_MODELS;
        break;
      case 'requesty':
        providerModels = REQUESTY_MODELS;
        break;
      case 'perplexity':
        providerModels = PERPLEXITY_MODELS;
        break;
      case 'openai-codex':
        providerModels = OPENAI_CODEX_MODELS;
        break;
      default:
        return [];
    }

    const convertedModels = providerModels.map(model => this.convertModelSpec(model));
    this.modelCache.set(providerId, convertedModels);
    
    return convertedModels;
  }

  /**
   * Convert ModelSpec to ModelWithProvider format
   */
  private convertModelSpec(model: ModelSpec): ModelWithProvider {
    return {
      provider: model.provider,
      id: model.apiName,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      pricing: {
        inputPerMillion: model.inputCostPerMillion,
        outputPerMillion: model.outputCostPerMillion,
        currency: 'USD'
      },
      capabilities: {
        supportsJSON: model.capabilities.supportsJSON,
        supportsImages: model.capabilities.supportsImages,
        supportsFunctions: model.capabilities.supportsFunctions,
        supportsStreaming: model.capabilities.supportsStreaming,
        supportsThinking: model.capabilities.supportsThinking
      }
    };
  }

  /**
   * Get provider information
   */
  getAvailableProviders(): string[] {
    return ['openai', 'anthropic', 'google', 'mistral', 'groq', 'openrouter', 'requesty', 'perplexity', 'openai-codex'];
  }

  /**
   * Check if a provider has models available
   */
  hasModelsForProvider(providerId: string): boolean {
    const models = this.getModelsForProvider(providerId);
    return models.length > 0;
  }

  /**
   * Find a specific model by provider and model ID
   * For OpenRouter, supports :online suffix (e.g., "gpt-4:online")
   */
  findModel(provider: string, modelId: string): ModelWithProvider | undefined {
    const providerModels = this.getModelsForProvider(provider);
    
    // For OpenRouter models, check if modelId has :online suffix
    if (provider === 'openrouter' && modelId.endsWith(':online')) {
      const baseModelId = modelId.replace(':online', '');
      return providerModels.find(model => model.id === baseModelId);
    }
    
    return providerModels.find(model => model.id === modelId);
  }

  /**
   * Get models suitable for specific tasks
   */
  getModelsForTask(taskType: 'coding' | 'writing' | 'analysis' | 'creative' | 'fast'): ModelWithProvider[] {
    const allModels = this.getAllModels();

    switch (taskType) {
      case 'coding':
        return allModels.filter(model => 
          model.capabilities.supportsFunctions || 
          model.id.includes('code') || 
          model.provider === 'mistral' ||
          model.id.includes('gpt-5')
        );
      
      case 'writing':
        return allModels.filter(model => 
          model.provider === 'anthropic' || 
          model.id.includes('gpt-5') ||
          model.contextWindow > 32000
        );
      
      case 'analysis':
        return allModels.filter(model => 
          model.provider === 'anthropic' ||
          model.id.includes('gpt-5') ||
          model.contextWindow > 100000
        );
      
      case 'creative':
        return allModels.filter(model => 
          model.provider === 'openai' ||
          model.provider === 'anthropic' ||
          model.provider === 'google'
        );
      
      case 'fast':
        return allModels.filter(model => 
          model.provider === 'groq' ||
          model.id.includes('turbo') ||
          model.id.includes('fast') ||
          model.id.includes('mini')
        );
      
      default:
        return allModels;
    }
  }

  /**
   * Get model statistics
   */
  getModelStatistics(): {
    totalModels: number;
    providerCount: number;
    averageContextWindow: number;
    maxContextWindow: number;
    minCostPerMillion: number;
    maxCostPerMillion: number;
  } {
    const allModels = this.getAllModels();
    
    if (allModels.length === 0) {
      return {
        totalModels: 0,
        providerCount: 0,
        averageContextWindow: 0,
        maxContextWindow: 0,
        minCostPerMillion: 0,
        maxCostPerMillion: 0
      };
    }

    const providers = new Set(allModels.map(m => m.provider));
    const contextWindows = allModels.map(m => m.contextWindow);
    const costs = allModels.map(m => m.pricing.inputPerMillion);

    return {
      totalModels: allModels.length,
      providerCount: providers.size,
      averageContextWindow: Math.round(contextWindows.reduce((a, b) => a + b, 0) / allModels.length),
      maxContextWindow: Math.max(...contextWindows),
      minCostPerMillion: Math.min(...costs),
      maxCostPerMillion: Math.max(...costs)
    };
  }
}