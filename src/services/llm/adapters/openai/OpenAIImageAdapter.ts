/**
 * OpenAI Image Generation Adapter
 * Location: src/services/llm/adapters/openai/OpenAIImageAdapter.ts
 *
 * Supports OpenAI's gpt-image-1 model via Responses API for image generation.
 * Uses nodeFetch to bypass CORS in Obsidian's Electron renderer.
 * Based on 2025 API documentation.
 */

import OpenAI from 'openai';
import { nodeFetch } from './nodeFetch';
import { BaseImageAdapter } from '../BaseImageAdapter';
import { 
  ImageGenerationParams, 
  ImageGenerationResponse, 
  ImageValidationResult,
  ImageModel,
  ImageUsage
} from '../../types/ImageTypes';
import { 
  ProviderConfig,
  ProviderCapabilities,
  ModelInfo,
  CostDetails
} from '../types';

export class OpenAIImageAdapter extends BaseImageAdapter {
  
  // Image adapters don't support streaming in the same way as text
  async* generateStreamAsync(): AsyncGenerator<never, void, unknown> {
    // Image generation is not streamable - it's a single result
    // This method should not be called for image adapters
    throw new Error('Image generation does not support streaming');
  }
  
  readonly name = 'openai-image';
  readonly baseUrl = 'https://api.openai.com/v1';
  readonly supportedModels: ImageModel[] = ['gpt-image-1'];
  readonly supportedSizes: string[] = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
  readonly supportedFormats: string[] = ['png'];
  
  private client: OpenAI;
  private readonly imageModel = 'gpt-image-1'; // Use gpt-image-1 via Responses API

  constructor(config?: ProviderConfig) {
    const apiKey = config?.apiKey || '';
    super(apiKey, 'gpt-image-1', config?.baseUrl);
    
    this.client = new OpenAI({
      apiKey: apiKey,
      organization: process.env.OPENAI_ORG_ID,
      project: process.env.OPENAI_PROJECT_ID,
      baseURL: config?.baseUrl || this.baseUrl,
      dangerouslyAllowBrowser: true, // Required for Obsidian plugin environment
      fetch: nodeFetch,              // Bypass CORS via Node.js http/https
    });

    this.initializeCache();
  }

  /**
   * Generate images using OpenAI's gpt-image-1 model via Responses API
   */
  async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResponse> {
    try {
      this.validateConfiguration();

      const response = await this.withRetry(async () => {
        // Use a supported model for Responses API (gpt-5.2 supports image_generation tool)
        const requestParams = {
          model: 'gpt-5.2', // Model that supports image_generation tool
          input: params.prompt,
          tools: [{
            type: 'image_generation' as const,
            size: params.size as 'auto' | '1024x1024' | '1536x1024' | '1024x1536' || '1024x1024'
            // quality and background removed - not in new interface
          }]
        };

        const result = await this.client.responses.create(requestParams);
        return result;
      }, 2); // Reduced retry count for faster failure detection

      return await this.buildImageResponse(response, params);
    } catch (error) {
      this.handleImageError(error, 'image generation', params);
    }
  }

  /**
   * Validate OpenAI-specific image generation parameters
   */
  validateImageParams(params: ImageGenerationParams): ImageValidationResult {
    // Start with common validation
    const baseValidation = this.validateCommonParams(params);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const errors: string[] = [...baseValidation.errors];
    const warnings: string[] = [...(baseValidation.warnings || [])];
    const adjustedParams: Partial<ImageGenerationParams> = {};

    // Validate prompt length (gpt-image-1 has a 32,000 character limit)
    if (params.prompt.length > 32000) {
      errors.push('Prompt too long (max 32,000 characters for gpt-image-1)');
    }

    // Validate model - only gpt-image-1 supported
    if (params.model && params.model !== 'gpt-image-1') {
      errors.push('Only gpt-image-1 model is supported for OpenAI');
    }

    // Size validation for gpt-image-1
    if (params.size) {
      const validSizes = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
      if (!validSizes.includes(params.size)) {
        errors.push(`Invalid size for gpt-image-1. Supported sizes: ${validSizes.join(', ')}`);
      }
    }

    // Quality and format validation removed - properties no longer in interface

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      adjustedParams
    };
  }

  /**
   * Get OpenAI image generation capabilities
   */
  getImageCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: false,
      supportsJSON: false,
      supportsImages: false,
      supportsFunctions: false,
      supportsThinking: false,
      supportsImageGeneration: true,
      maxContextWindow: 32000, // Character limit for prompts
      supportedFeatures: [
        'text_to_image',
        'quality_control',
        'size_variants',
        'style_control',
        'high_resolution'
      ]
    };
  }

  /**
   * Get supported image sizes for gpt-image-1
   */
  getSupportedImageSizes(): string[] {
    return [...this.supportedSizes];
  }

  /**
   * Get pricing for gpt-image-1 image generation
   */
  async getImageModelPricing(model: string = 'gpt-image-1'): Promise<CostDetails> {
    // gpt-image-1 pricing is token-based, approximate base price
    const basePrice = 0.015; // Approximate cost per image

    return {
      inputCost: 0,
      outputCost: basePrice,
      totalCost: basePrice,
      currency: 'USD',
      rateInputPerMillion: 0,
      rateOutputPerMillion: basePrice * 1_000_000
    };
  }

  /**
   * List available OpenAI image models
   */
  async listModels(): Promise<ModelInfo[]> {
    return [{
      id: this.imageModel,
      name: 'GPT Image 1',
      contextWindow: 32000,
      maxOutputTokens: 0,
      supportsJSON: false,
      supportsImages: false,
      supportsFunctions: false,
      supportsStreaming: false,
      supportsThinking: false,
      supportsImageGeneration: true,
      pricing: {
        inputPerMillion: 0,
        outputPerMillion: 0,
        imageGeneration: 0.015,
        currency: 'USD',
        lastUpdated: '2025-01-01'
      }
    }];
  }

  // Private helper methods

  private async buildImageResponse(
    response: any, // Responses API response format
    params: ImageGenerationParams
  ): Promise<ImageGenerationResponse> {
    // Extract image data from Responses API format
    const imageData = response.output
      .filter((output: { type: string; result?: string }) => output.type === "image_generation_call")
      .map((output: { result?: string }) => output.result);

    if (!imageData || imageData.length === 0) {
      throw new Error('No image data received from OpenAI Responses API');
    }

    const imageBase64 = imageData[0];
    if (!imageBase64) {
      throw new Error('No base64 image data received from OpenAI');
    }

    // Convert base64 to buffer
    const buffer = Buffer.from(imageBase64, 'base64');

    // Extract dimensions from size parameter or use default
    const size = params.size || '1024x1024';
    const [width, height] = size === 'auto' ? [1024, 1024] : size.split('x').map(Number);

    const usage: ImageUsage = this.buildImageUsage(1, size, this.imageModel);

    // Extract revised prompt from image generation call
    const imageGenerationCall = response.output.find((output: { type: string; result?: string }) => output.type === "image_generation_call");
    const revisedPrompt = imageGenerationCall?.revised_prompt;

    return {
      imageData: buffer,
      format: 'png', // Default format for Responses API
      dimensions: { width, height },
      metadata: {
        size: params.size || '1024x1024',
        responseFormat: 'responses_api',
        model: this.imageModel,
        provider: this.name,
        generatedAt: new Date().toISOString(),
        originalPrompt: params.prompt,
        responseId: response.id,
        apiResponse: {
          outputCount: response.output.length,
          imageOutputCount: imageData.length
        }
      },
      usage,
      revisedPrompt: revisedPrompt
    };
  }
}