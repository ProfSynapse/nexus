/**
 * Base Image Generation Adapter
 * Abstract class that image generation adapters extend
 * Provides common functionality for image generation while extending BaseAdapter
 */

import { BaseAdapter } from './BaseAdapter';
import { 
  ImageGenerationParams, 
  ImageGenerationResponse, 
  ImageGenerationResult,
  ImageValidationResult,
  ImageCostDetails,
  ImageGenerationError,
  ImageProvider,
  ImageModel,
  ImageUsage
} from '../types/ImageTypes';
import { ProviderCapabilities, ModelInfo, CostDetails } from './types';

export abstract class BaseImageAdapter extends BaseAdapter {
  abstract readonly supportedModels: ImageModel[];
  abstract readonly supportedSizes: string[];
  abstract readonly supportedFormats: string[];

  constructor(
    apiKey: string, 
    defaultModel: string, 
    baseUrl?: string
  ) {
    super(
      apiKey,
      defaultModel,
      baseUrl,
      true // requiresApiKey
    );
  }

  // Abstract methods that each image provider must implement
  abstract generateImage(params: ImageGenerationParams): Promise<ImageGenerationResponse>;
  abstract validateImageParams(params: ImageGenerationParams): ImageValidationResult;
  abstract getImageCapabilities(): ProviderCapabilities;
  abstract getSupportedImageSizes(): string[];
  abstract getImageModelPricing(model: string): Promise<CostDetails | null>;

  /**
   * Generate image with comprehensive validation and error handling
   */
  async generateImageSafely(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    const startTime = Date.now();

    try {
      // Validate parameters first
      const validation = this.validateImageParams(params);
      if (!validation.isValid) {
        return {
          success: false,
          error: `Parameter validation failed: ${validation.errors.join(', ')}`,
          validationErrors: validation.errors
        };
      }

      // Use adjusted parameters if provided
      const finalParams = { ...params, ...validation.adjustedParams };

      // Generate the image with timeout
      const response = await Promise.race([
        this.generateImage(finalParams),
        this.createTimeoutPromise(120000) // 2 minute timeout
      ]);

      const generationTime = Date.now() - startTime;

      // Calculate costs
      const cost = await this.calculateImageCost(response, finalParams.model || this.currentModel);

      return {
        success: true,
        data: {
          imagePath: finalParams.savePath,
          prompt: finalParams.prompt,
          revisedPrompt: response.revisedPrompt,
          model: finalParams.model || this.currentModel,
          provider: this.name as ImageProvider,
          dimensions: response.dimensions,
          fileSize: response.imageData.length,
          format: response.format,
          cost: cost || undefined,
          usage: response.usage,
          metadata: {
            ...response.metadata,
            generationTimeMs: generationTime
          }
        }
      };
    } catch (error) {
      const generationTime = Date.now() - startTime;
      console.error(`[${this.name}] Image generation failed after ${generationTime}ms:`, error);
      
      if (error instanceof ImageGenerationError) {
        return {
          success: false,
          error: error.message
        };
      }

      // Handle timeout specifically
      if (error instanceof Error && error.message === 'Image generation timed out') {
        return {
          success: false,
          error: `Image generation timed out after ${Math.round(generationTime / 1000)}s. This can happen with complex prompts or high server load. Please try again with a simpler prompt.`
        };
      }

      return {
        success: false,
        error: `Image generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Create a timeout promise that rejects after specified milliseconds
   */
  private createTimeoutPromise(timeoutMs: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Image generation timed out'));
      }, timeoutMs);
    });
  }

  /**
   * Check if the adapter is available for image generation
   */
  async isImageGenerationAvailable(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }

    try {
      const capabilities = this.getImageCapabilities();
      return capabilities.supportsImageGeneration || false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get all supported models with their capabilities
   */
  async getImageModels(): Promise<ModelInfo[]> {
    const models = await this.listModels();
    return models.filter(model => model.supportsImageGeneration);
  }

  /**
   * Calculate image generation cost
   */
  protected async calculateImageCost(
    response: ImageGenerationResponse, 
    model: string
  ): Promise<ImageCostDetails | null> {
    try {
      const pricing = await this.getImageModelPricing(model);
      if (!pricing) {
        return null;
      }

      const usage = response.usage;
      if (!usage) {
        return null;
      }

      // For image generation, we typically have a per-image cost
      const totalCost = pricing.totalCost * usage.imagesGenerated;

      return {
        inputCost: 0, // Images don't have input tokens in the traditional sense
        outputCost: totalCost,
        totalCost,
        currency: pricing.currency,
        ratePerImage: pricing.totalCost,
        resolution: usage.resolution,
        imagesGenerated: usage.imagesGenerated
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Validate common image parameters
   */
  protected validateCommonParams(params: ImageGenerationParams): ImageValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate prompt
    if (!params.prompt || params.prompt.trim().length === 0) {
      errors.push('Prompt is required');
    }

    // Validate save path
    if (!params.savePath || params.savePath.trim().length === 0) {
      errors.push('Save path is required');
    }

    // Check if path is trying to escape vault
    if (params.savePath?.includes('..') || params.savePath?.startsWith('/')) {
      errors.push('Save path must be relative to vault root');
    }

    // Validate model if specified
    if (params.model && !this.supportedModels.includes(params.model as ImageModel)) {
      errors.push(`Model ${params.model} not supported. Supported models: ${this.supportedModels.join(', ')}`);
    }

    // Validate size if specified
    if (params.size && !this.supportedSizes.includes(params.size)) {
      errors.push(`Size ${params.size} not supported. Supported sizes: ${this.supportedSizes.join(', ')}`);
    }

    // Format validation removed - Google Imagen only outputs PNG

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Build image usage tracking object
   */
  protected buildImageUsage(
    imagesGenerated: number, 
    resolution: string, 
    model: string
  ): ImageUsage {
    return {
      imagesGenerated,
      resolution,
      model,
      provider: this.name
    };
  }

  /**
   * Handle image-specific errors
   */
  protected handleImageError(error: any, operation: string, params?: ImageGenerationParams): never {
    if (error instanceof ImageGenerationError) {
      throw error;
    }

    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.error?.message || error.message;
      
      let errorCode = 'HTTP_ERROR';
      if (status === 401) errorCode = 'AUTHENTICATION_ERROR';
      if (status === 403) errorCode = 'CONTENT_FILTER_ERROR';
      if (status === 429) errorCode = 'RATE_LIMIT_ERROR';
      if (status === 400) errorCode = 'INVALID_REQUEST';

      throw new ImageGenerationError(
        `${operation} failed: ${message}`,
        this.name,
        errorCode,
        error,
        params
      );
    }

    throw new ImageGenerationError(
      `${operation} failed: ${error.message || 'Unknown error'}`,
      this.name,
      'UNKNOWN_ERROR',
      error,
      params
    );
  }

  // Required BaseAdapter methods (stub implementations for image-only adapters)
  async generateUncached(): Promise<any> {
    throw new Error('Use generateImage() for image generation. This adapter only supports image generation.');
  }

  async generateStream(): Promise<any> {
    throw new Error('Streaming not supported for image generation');
  }

  getCapabilities(): ProviderCapabilities {
    return this.getImageCapabilities();
  }

  async getModelPricing(modelId: string): Promise<CostDetails | null> {
    return await this.getImageModelPricing(modelId);
  }
}