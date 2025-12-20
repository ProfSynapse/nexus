/**
 * LLM Provider Manager
 * Handles model filtering, provider management, and model information
 */

import { Vault } from 'obsidian';
import { ModelInfo } from '../adapters/types';
import { LLMProviderSettings, LLMProviderConfig } from '../../../types';
import { LLMService } from '../core/LLMService';

export interface ModelWithProvider extends ModelInfo {
  provider: string;
  userDescription?: string;
  isDefault?: boolean;
  modelDescription?: string; // User-defined description for when to use this specific model (deprecated)
}

export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  isAvailable: boolean;
  isEnabled: boolean;
  hasApiKey: boolean;
  userDescription?: string;
}

export class LLMProviderManager {
  private llmService: LLMService;
  private settings: LLMProviderSettings;
  private vault?: Vault;

  constructor(settings: LLMProviderSettings, vault?: Vault) {
    this.settings = settings;
    this.vault = vault;
    this.llmService = new LLMService(settings, vault);
  }

  /**
   * Update settings and reinitialize services
   */
  updateSettings(settings: LLMProviderSettings): void {
    this.settings = settings;
    this.llmService.updateSettings(settings);
  }

  /**
   * Set VaultOperations for file reading
   */
  setVaultOperations(vaultOperations: any): void {
    this.llmService.setVaultOperations(vaultOperations);
  }

  /**
   * @deprecated Use setVaultOperations instead
   * Kept for backward compatibility
   */
  setVaultAdapter(adapter: any): void {
  }

  /**
   * Get LLM service instance
   */
  getLLMService(): LLMService {
    return this.llmService;
  }

  /**
   * Get current settings
   */
  getSettings(): LLMProviderSettings {
    return this.settings;
  }

  /**
   * Get all available models from enabled providers only
   * Uses static models from *Models.ts files, not live API calls
   */
  async getAvailableModels(): Promise<ModelWithProvider[]> {
    const { StaticModelsService } = await import('../../StaticModelsService');
    const staticModelsService = StaticModelsService.getInstance();
    const defaultModel = this.settings.defaultModel;
    const allModels: ModelWithProvider[] = [];

    // Get enabled providers
    const enabledProviders = this.getEnabledProviders();
    
    // For each enabled provider, get their models
    for (const provider of enabledProviders) {
      if (provider.id === 'ollama') {
        // Special handling for Ollama - only return the user-configured model
        const ollamaModel = this.settings.providers.ollama?.ollamaModel;

        if (ollamaModel && ollamaModel.trim()) {
          allModels.push({
            provider: 'ollama',
            id: ollamaModel,
            name: ollamaModel,
            contextWindow: 128000, // Fixed reasonable default
            maxOutputTokens: 4096,
            supportsJSON: false,
            supportsImages: ollamaModel.includes('vision') || ollamaModel.includes('llava'),
            supportsFunctions: false,
            supportsStreaming: true,
            supportsThinking: false,
            pricing: {
              inputPerMillion: 0,
              outputPerMillion: 0,
              currency: 'USD',
              lastUpdated: new Date().toISOString()
            },
            isDefault: defaultModel.provider === 'ollama' && defaultModel.model === ollamaModel,
            userDescription: this.settings.providers.ollama?.userDescription
          });
        }
      } else if (provider.id === 'lmstudio') {
        // Special handling for LM Studio - dynamically discover models from server
        try {
          const adapter = this.llmService.getAdapter('lmstudio');

          if (!adapter) {
            // Expected when LM Studio server URL isn't configured - silently skip
            continue;
          }

          const lmstudioModels = await adapter.listModels();

          for (const model of lmstudioModels) {
            allModels.push({
              provider: 'lmstudio',
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow,
              maxOutputTokens: model.maxOutputTokens || 2048,
              supportsJSON: model.supportsJSON,
              supportsImages: model.supportsImages,
              supportsFunctions: model.supportsFunctions,
              supportsStreaming: model.supportsStreaming,
              supportsThinking: model.supportsThinking,
              pricing: {
                inputPerMillion: 0, // Local models are free
                outputPerMillion: 0,
                currency: 'USD',
                lastUpdated: new Date().toISOString()
              },
              isDefault: defaultModel.provider === 'lmstudio' && defaultModel.model === model.id,
              userDescription: this.settings.providers.lmstudio?.userDescription
            });
          }
        } catch {
          // LM Studio server not reachable - silently skip (app probably not running)
          // Don't fail the entire method, just skip LM Studio models
        }
      } else if (provider.id === 'webllm') {
        // Special handling for WebLLM - load from WEBLLM_MODELS
        try {
          const { WEBLLM_MODELS } = await import('../adapters/webllm/WebLLMModels');

          for (const model of WEBLLM_MODELS) {
            allModels.push({
              provider: 'webllm',
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow,
              maxOutputTokens: model.maxTokens,
              supportsJSON: model.capabilities.supportsJSON,
              supportsImages: model.capabilities.supportsImages,
              supportsFunctions: model.capabilities.supportsFunctions,
              supportsStreaming: model.capabilities.supportsStreaming,
              supportsThinking: model.capabilities.supportsThinking ?? false,
              pricing: {
                inputPerMillion: 0, // Local models are free
                outputPerMillion: 0,
                currency: 'USD',
                lastUpdated: new Date().toISOString()
              },
              isDefault: defaultModel.provider === 'webllm' && defaultModel.model === model.id,
              userDescription: this.settings.providers.webllm?.userDescription
            });
          }
        } catch (error) {
          console.error('[ProviderManager] Failed to load WebLLM models:', error);
        }
      } else {
        // For other providers, use static models
        const providerModels = staticModelsService.getModelsForProvider(provider.id);

        const modelsWithProviderInfo = providerModels
          .filter(model => {
            // Filter by model-level enabled status (default to true for backwards compatibility)
            const modelConfig = this.settings.providers[model.provider]?.models?.[model.id];
            return modelConfig?.enabled !== false;
          })
          .map(model => ({
            provider: model.provider,
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxTokens,
            supportsJSON: model.capabilities.supportsJSON,
            supportsImages: model.capabilities.supportsImages,
            supportsFunctions: model.capabilities.supportsFunctions,
            supportsStreaming: model.capabilities.supportsStreaming,
            supportsThinking: model.capabilities.supportsThinking,
            pricing: {
              inputPerMillion: model.pricing.inputPerMillion,
              outputPerMillion: model.pricing.outputPerMillion,
              currency: model.pricing.currency,
              lastUpdated: new Date().toISOString()
            },
            isDefault: model.provider === defaultModel.provider && model.id === defaultModel.model,
            userDescription: this.settings.providers[model.provider]?.userDescription,
            // Keep deprecated field for backwards compatibility
            modelDescription: this.settings.providers[model.provider]?.models?.[model.id]?.description
          }));

        allModels.push(...modelsWithProviderInfo);
      }
    }

    return allModels;
  }


  /**
   * Get provider information for all supported providers
   */
  getProviderInfo(): ProviderInfo[] {
    const supportedProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        description: 'GPT models including GPT-4, GPT-3.5-turbo, and specialized models'
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        description: 'Claude models with strong reasoning and safety features'
      },
      {
        id: 'google',
        name: 'Google',
        description: 'Gemini models with multimodal capabilities and thinking mode'
      },
      {
        id: 'mistral',
        name: 'Mistral',
        description: 'European models with strong coding and multilingual support'
      },
      {
        id: 'groq',
        name: 'Groq',
        description: 'Ultra-fast inference speeds for quick responses'
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        description: 'Access to 400+ models from multiple providers in one API'
      },
      {
        id: 'requesty',
        name: 'Requesty',
        description: 'Premium model access with cost optimization'
      },
      {
        id: 'perplexity',
        name: 'Perplexity',
        description: 'Web search-enabled models with real-time information and citations'
      },
      {
        id: 'webllm',
        name: 'Nexus (Local)',
        description: 'Local AI via WebGPU - runs in browser, completely private, no API costs'
      },
      {
        id: 'ollama',
        name: 'Ollama (Local)',
        description: 'Local LLM execution with complete privacy and no API costs'
      },
      {
        id: 'lmstudio',
        name: 'LM Studio (Local)',
        description: 'Local LLM execution with OpenAI-compatible API and model management'
      }
    ];

    return supportedProviders.map(provider => {
      const config = this.settings.providers[provider.id];
      const isAvailable = this.llmService.isProviderAvailable(provider.id);

      // For local providers, check if server URL is configured (except webllm which needs nothing)
      let hasApiKey = false;
      if (provider.id === 'webllm') {
        hasApiKey = true; // WebLLM doesn't need an API key
      } else if (provider.id === 'ollama' || provider.id === 'lmstudio') {
        hasApiKey = !!(config?.apiKey && config.apiKey.trim());
      } else {
        hasApiKey = !!(config?.apiKey && config.apiKey.length > 0);
      }

      return {
        ...provider,
        isAvailable,
        isEnabled: config?.enabled || false,
        hasApiKey,
        userDescription: config?.userDescription
      };
    });
  }

  /**
   * Get enabled provider information only
   */
  getEnabledProviders(): ProviderInfo[] {
    const allProviders = this.getProviderInfo();
    const enabled = allProviders.filter(provider => {
      if (!provider.isEnabled) return false;

      // For Ollama and LM Studio, hasApiKey check should consider server URL
      if (provider.id === 'ollama' || provider.id === 'lmstudio') {
        const config = this.settings.providers[provider.id];
        return !!(config?.apiKey && config.apiKey.trim());
      } else {
        return provider.hasApiKey;
      }
    });
    
    
    return enabled;
  }

  /**
   * Get models for a specific provider (if enabled)
   */
  async getModelsForProvider(providerId: string): Promise<ModelWithProvider[]> {
    const allModels = await this.getAvailableModels();
    return allModels.filter(model => model.provider === providerId);
  }

  /**
   * Get models grouped by provider
   */
  async getModelsByProvider(): Promise<{ [providerId: string]: ModelWithProvider[] }> {
    const models = await this.getAvailableModels();
    const grouped: { [providerId: string]: ModelWithProvider[] } = {};

    models.forEach(model => {
      if (!grouped[model.provider]) {
        grouped[model.provider] = [];
      }
      grouped[model.provider].push(model);
    });

    return grouped;
  }

  /**
   * Find a specific model by provider and model ID
   * For OpenRouter, supports :online suffix (e.g., "gpt-4:online")
   */
  async findModel(provider: string, modelId: string): Promise<ModelWithProvider | undefined> {
    const models = await this.getAvailableModels();
    
    // For OpenRouter models, check if modelId has :online suffix
    if (provider === 'openrouter' && modelId.endsWith(':online')) {
      const baseModelId = modelId.replace(':online', '');
      return models.find(model => model.provider === provider && model.id === baseModelId);
    }
    
    return models.find(model => model.provider === provider && model.id === modelId);
  }

  /**
   * Get the default model information
   */
  async getDefaultModelInfo(): Promise<ModelWithProvider | undefined> {
    const defaultModel = this.settings.defaultModel;
    return this.findModel(defaultModel.provider, defaultModel.model);
  }

  /**
   * Validate that a provider/model combination is available
   * For OpenRouter, supports :online suffix (e.g., "gpt-4:online")
   */
  async validateProviderModel(provider: string, model: string): Promise<boolean> {
    const foundModel = await this.findModel(provider, model);
    return !!foundModel;
  }

  /**
   * Get models suitable for a specific task type
   */
  async getModelsForTask(taskType: 'coding' | 'writing' | 'analysis' | 'creative' | 'fast'): Promise<ModelWithProvider[]> {
    const allModels = await this.getAvailableModels();

    switch (taskType) {
      case 'coding':
        return allModels.filter(model => 
          model.supportsFunctions || 
          model.id.includes('code') || 
          model.provider === 'mistral' ||
          model.id.includes('gpt-4')
        );
      
      case 'writing':
        return allModels.filter(model => 
          model.provider === 'anthropic' || 
          model.id.includes('gpt-4') ||
          model.contextWindow > 32000
        );
      
      case 'analysis':
        return allModels.filter(model => 
          model.provider === 'anthropic' ||
          model.id.includes('gpt-4') ||
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
          model.id.includes('fast')
        );
      
      default:
        return allModels;
    }
  }

  /**
   * Get cost estimate for a provider/model combination
   */
  async getCostEstimate(
    provider: string, 
    model: string, 
    estimatedTokens: number
  ): Promise<{ inputCost: number; outputCost: number; totalCost: number; currency: string } | null> {
    const modelInfo = await this.findModel(provider, model);
    if (!modelInfo) return null;

    // Estimate 75% input, 25% output tokens
    const inputTokens = Math.floor(estimatedTokens * 0.75);
    const outputTokens = Math.floor(estimatedTokens * 0.25);

    const inputCost = (inputTokens / 1_000_000) * modelInfo.pricing.inputPerMillion;
    const outputCost = (outputTokens / 1_000_000) * modelInfo.pricing.outputPerMillion;
    const totalCost = inputCost + outputCost;

    return {
      inputCost,
      outputCost,
      totalCost,
      currency: modelInfo.pricing.currency
    };
  }

  /**
   * Get recommended models based on context window requirements
   */
  async getRecommendedModels(requiredContextWindow?: number): Promise<ModelWithProvider[]> {
    const allModels = await this.getAvailableModels();
    
    if (!requiredContextWindow) {
      // Return default recommendations
      return allModels
        .filter(model => model.contextWindow >= 32000)
        .sort((a, b) => {
          // Prioritize by: 1) Default model, 2) Context window, 3) Provider quality
          if (a.isDefault) return -1;
          if (b.isDefault) return 1;
          return b.contextWindow - a.contextWindow;
        })
        .slice(0, 5);
    }

    return allModels
      .filter(model => model.contextWindow >= requiredContextWindow)
      .sort((a, b) => a.pricing.inputPerMillion - b.pricing.inputPerMillion); // Sort by cost
  }

  /**
   * Test connection to all enabled providers
   */
  async testAllProviders(): Promise<{ [providerId: string]: { success: boolean; error?: string } }> {
    const enabledProviders = this.getEnabledProviders();
    const results: { [providerId: string]: { success: boolean; error?: string } } = {};

    for (const provider of enabledProviders) {
      results[provider.id] = await this.llmService.testProvider(provider.id);
    }

    return results;
  }

  /**
   * Get statistics about available models
   */
  async getModelStatistics(): Promise<{
    totalModels: number;
    providerCount: number;
    averageContextWindow: number;
    maxContextWindow: number;
    minCostPerMillion: number;
    maxCostPerMillion: number;
  }> {
    const models = await this.getAvailableModels();
    
    if (models.length === 0) {
      return {
        totalModels: 0,
        providerCount: 0,
        averageContextWindow: 0,
        maxContextWindow: 0,
        minCostPerMillion: 0,
        maxCostPerMillion: 0
      };
    }

    const providers = new Set(models.map(m => m.provider));
    const contextWindows = models.map(m => m.contextWindow);
    const costs = models.map(m => m.pricing.inputPerMillion);

    return {
      totalModels: models.length,
      providerCount: providers.size,
      averageContextWindow: Math.round(contextWindows.reduce((a, b) => a + b, 0) / models.length),
      maxContextWindow: Math.max(...contextWindows),
      minCostPerMillion: Math.min(...costs),
      maxCostPerMillion: Math.max(...costs)
    };
  }
}
