/**
 * Image Generation Service
 * Central orchestration service for image generation workflow
 * Coordinates between adapters, file management, and cost tracking
 */

import { Vault } from 'obsidian';
import { OpenAIImageAdapter } from './adapters/openai/OpenAIImageAdapter'; // Available but not used
import { GeminiImageAdapter } from './adapters/google/GeminiImageAdapter';
import { OpenRouterImageAdapter } from './adapters/openrouter/OpenRouterImageAdapter';
import { ImageFileManager } from './ImageFileManager';
import { 
  ImageGenerationParams, 
  ImageGenerationResult,
  ImageProvider,
  ImageValidationResult,
  ImageGenerationError
} from './types/ImageTypes';
import { BaseImageAdapter } from './adapters/BaseImageAdapter';
import { LLMProviderSettings } from '../../types/llm/ProviderTypes';

export class ImageGenerationService {
  private adapters: Map<ImageProvider, BaseImageAdapter>;
  private fileManager: ImageFileManager;
  private vault: Vault;
  private llmSettings: LLMProviderSettings | null = null;

  constructor(vault: Vault, llmSettings?: LLMProviderSettings) {
    this.vault = vault;
    this.fileManager = new ImageFileManager(vault);
    this.adapters = new Map();
    this.llmSettings = llmSettings || null;
    
    this.initializeAdapters();
  }

  /**
   * Initialize image generation adapters
   */
  private initializeAdapters(): void {
    try {
      if (!this.llmSettings) {
        return;
      }

      // Initialize OpenAI adapter (DISABLED - available but not active)
      // Uncomment the block below to enable OpenAI image generation
      /*
      const openaiConfig = this.llmSettings.providers?.openai;
      if (openaiConfig?.apiKey && openaiConfig?.enabled) {
        const openaiAdapter = new OpenAIImageAdapter({
          apiKey: openaiConfig.apiKey
        });
        this.adapters.set('openai', openaiAdapter);
      }
      */

      // Initialize Google adapter if API key is available and enabled
      const googleConfig = this.llmSettings.providers?.google;
      if (googleConfig?.apiKey && googleConfig?.enabled) {
        const googleAdapter = new GeminiImageAdapter({
          apiKey: googleConfig.apiKey,
          vault: this.vault // Pass vault for reference image loading
        });
        this.adapters.set('google', googleAdapter);
      }

      // Initialize OpenRouter adapter if API key is available and enabled
      const openRouterConfig = this.llmSettings.providers?.openrouter;
      if (openRouterConfig?.apiKey && openRouterConfig?.enabled) {
        const openRouterAdapter = new OpenRouterImageAdapter({
          apiKey: openRouterConfig.apiKey,
          vault: this.vault,
          httpReferer: openRouterConfig.httpReferer,
          xTitle: openRouterConfig.xTitle
        });
        this.adapters.set('openrouter', openRouterAdapter);
      }
    } catch (error) {
      console.error('Failed to initialize image generation adapters:', error);
    }
  }

  /**
   * Generate image with full workflow orchestration
   */
  async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    try {
      // Validate provider
      const adapter = this.getAdapter(params.provider);
      if (!adapter) {
        return {
          success: false,
          error: `Provider ${params.provider} not available. Please configure the appropriate API key.`
        };
      }

      // Check if adapter is available for image generation
      const isAvailable = await adapter.isImageGenerationAvailable();
      if (!isAvailable) {
        return {
          success: false,
          error: `Image generation not available for provider ${params.provider}. Please check API key configuration.`
        };
      }

      // Generate the image using the adapter
      const result = await adapter.generateImageSafely(params);
      
      if (!result.success || !result.data) {
        return result;
      }

      // Generate the image response for file saving
      const imageResponse = await adapter.generateImage(params);

      // Save the image to vault
      const saveResult = await this.fileManager.saveImage(imageResponse, params);
      
      if (!saveResult.success) {
        return {
          success: false,
          error: `Image generation succeeded but file save failed: ${saveResult.error}`
        };
      }

      // Update the result with the actual saved path
      return {
        success: true,
        data: {
          ...result.data,
          imagePath: saveResult.filePath,
          fileSize: saveResult.fileSize
        }
      };

    } catch (error) {
      console.error('Image generation service error:', error);
      
      if (error instanceof ImageGenerationError) {
        return {
          success: false,
          error: error.message
        };
      }

      return {
        success: false,
        error: `Image generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Validate image generation parameters across all providers
   */
  async validateParams(params: ImageGenerationParams): Promise<ImageValidationResult> {
    try {
      const adapter = this.getAdapter(params.provider);
      if (!adapter) {
        return {
          isValid: false,
          errors: [`Provider ${params.provider} not available`]
        };
      }

      return adapter.validateImageParams(params);
    } catch (error) {
      return {
        isValid: false,
        errors: [`Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`]
      };
    }
  }

  /**
   * Get available providers with their status
   */
  async getAvailableProviders(): Promise<Array<{
    provider: ImageProvider;
    available: boolean;
    models: string[];
    error?: string;
  }>> {
    const providers: Array<{
      provider: ImageProvider;
      available: boolean;
      models: string[];
      error?: string;
    }> = [];

    for (const [providerName, adapter] of this.adapters) {
      try {
        const available = await adapter.isImageGenerationAvailable();
        const models = available ? adapter.supportedModels : [];
        
        providers.push({
          provider: providerName,
          available,
          models,
          error: available ? undefined : 'API key not configured or invalid'
        });
      } catch (error) {
        providers.push({
          provider: providerName,
          available: false,
          models: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Add unavailable providers if no API keys are configured
    const allProviders: ImageProvider[] = ['openai', 'google', 'openrouter']; // OpenAI available but disabled
    for (const provider of allProviders) {
      if (!providers.find(p => p.provider === provider)) {
        providers.push({
          provider,
          available: false,
          models: [],
          error: provider === 'openai' ? 'Provider disabled (available in code)' : 'API key not configured'
        });
      }
    }

    return providers;
  }

  /**
   * Get supported models for a provider
   */
  async getSupportedModels(provider: ImageProvider): Promise<string[]> {
    const adapter = this.getAdapter(provider);
    if (!adapter) {
      return [];
    }

    try {
      const available = await adapter.isImageGenerationAvailable();
      return available ? adapter.supportedModels : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Get supported sizes for a provider
   */
  getSupportedSizes(provider: ImageProvider): string[] {
    const adapter = this.getAdapter(provider);
    return adapter ? adapter.getSupportedImageSizes() : [];
  }

  /**
   * Get provider capabilities
   */
  async getProviderCapabilities(provider: ImageProvider) {
    const adapter = this.getAdapter(provider);
    if (!adapter) {
      return null;
    }

    try {
      return adapter.getImageCapabilities();
    } catch (error) {
      return null;
    }
  }

  /**
   * Estimate cost for image generation
   */
  async estimateCost(params: ImageGenerationParams): Promise<{
    estimatedCost: number;
    currency: string;
    breakdown: string;
  } | null> {
    const adapter = this.getAdapter(params.provider);
    if (!adapter) {
      return null;
    }

    try {
      const model = params.model || adapter.supportedModels[0];
      const pricing = await adapter.getImageModelPricing(model);
      
      if (!pricing) {
        return null;
      }

      return {
        estimatedCost: pricing.totalCost,
        currency: pricing.currency,
        breakdown: `1 image using ${model}: ${pricing.totalCost} ${pricing.currency}`
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if any image generation providers are available
   */
  hasAvailableProviders(): boolean {
    return this.adapters.size > 0;
  }

  /**
   * Get file manager instance
   */
  getFileManager(): ImageFileManager {
    return this.fileManager;
  }

  /**
   * Update LLM settings and refresh adapters
   */
  updateSettings(llmSettings: LLMProviderSettings): void {
    this.llmSettings = llmSettings;
    this.refreshAdapters();
  }

  /**
   * Refresh adapter configurations (useful after API key changes)
   */
  refreshAdapters(): void {
    this.adapters.clear();
    this.initializeAdapters();
  }

  // Private helper methods

  private getAdapter(provider: ImageProvider): BaseImageAdapter | undefined {
    return this.adapters.get(provider);
  }

  /**
   * Validate common parameters before generation
   */
  private validateCommonParams(params: ImageGenerationParams): string[] {
    const errors: string[] = [];

    if (!params.prompt || params.prompt.trim().length === 0) {
      errors.push('Prompt is required');
    }

    if (!params.savePath || params.savePath.trim().length === 0) {
      errors.push('Save path is required');
    }

    if (!params.provider) {
      errors.push('Provider is required');
    }

    if (params.savePath && (params.savePath.includes('..') || params.savePath.startsWith('/'))) {
      errors.push('Save path must be relative to vault root');
    }

    return errors;
  }
}