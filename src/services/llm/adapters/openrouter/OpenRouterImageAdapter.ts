/**
 * OpenRouter Image Generation Adapter
 * Supports image generation through OpenRouter's unified API
 * Uses models with "image" in their output_modalities
 *
 * API: POST /api/v1/chat/completions with modalities: ['image', 'text']
 */

import { Vault, requestUrl } from 'obsidian';
import { BaseImageAdapter } from '../BaseImageAdapter';
import {
  ImageGenerationParams,
  ImageGenerationResponse,
  ImageValidationResult,
  ImageModel,
  ImageUsage,
  AspectRatio,
  NanoBananaImageSize
} from '../../types/ImageTypes';
import {
  ProviderConfig,
  ProviderCapabilities,
  ModelInfo,
  CostDetails
} from '../types';
import { BRAND_NAME } from '../../../../constants/branding';

export class OpenRouterImageAdapter extends BaseImageAdapter {

  async* generateStreamAsync(): AsyncGenerator<never, void, unknown> {
    throw new Error('Image generation does not support streaming');
  }

  readonly name = 'openrouter-image';
  readonly baseUrl = 'https://openrouter.ai/api/v1';
  readonly supportedModels: ImageModel[] = [
    'gemini-2.5-flash-image' as ImageModel,
    'gemini-3-pro-image-preview' as ImageModel
  ];
  readonly supportedSizes: string[] = ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'];
  readonly supportedFormats: string[] = ['png', 'jpeg', 'webp'];

  private vault: Vault | null = null;
  private httpReferer: string;
  private xTitle: string;

  // OpenRouter model IDs for image generation
  private readonly modelMap: Record<string, string> = {
    'gemini-2.5-flash-image': 'google/gemini-2.5-flash-image-preview',
    'gemini-3-pro-image-preview': 'google/gemini-3-pro-image-preview',
    // Add other image-capable models as they become available
    'flux-2-pro': 'black-forest-labs/flux.2-pro',
    'flux-2-flex': 'black-forest-labs/flux.2-flex'
  };

  private readonly defaultModel = 'gemini-2.5-flash-image';

  // Supported aspect ratios per OpenRouter docs
  private readonly openRouterAspectRatios = [
    '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'
  ];

  constructor(config?: ProviderConfig & { vault?: Vault; httpReferer?: string; xTitle?: string }) {
    const apiKey = config?.apiKey || '';
    super(apiKey, 'gemini-2.5-flash-image', config?.baseUrl);

    if (config?.vault) {
      this.vault = config.vault;
    }

    this.httpReferer = config?.httpReferer?.trim() || 'https://synapticlabs.ai';
    this.xTitle = config?.xTitle?.trim() || BRAND_NAME;

    this.initializeCache();
  }

  /**
   * Set vault for reading reference images
   */
  setVault(vault: Vault): void {
    this.vault = vault;
  }

  /**
   * Generate images using OpenRouter's unified API
   * Uses modalities: ['image', 'text'] for image generation
   */
  async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResponse> {
    try {
      this.validateConfiguration();

      const model = params.model || this.defaultModel;
      const openRouterModel = this.modelMap[model] || `google/${model}`;

      const response = await this.withRetry(async () => {
        // Build message content with prompt and reference images
        const content: any[] = [{ type: 'text', text: params.prompt }];

        // Add reference images if provided
        if (params.referenceImages && params.referenceImages.length > 0) {
          const referenceImageParts = await this.loadReferenceImages(params.referenceImages);
          content.push(...referenceImageParts);
        }

        // Build request body per OpenRouter docs
        const requestBody: any = {
          model: openRouterModel,
          messages: [
            {
              role: 'user',
              content: content.length === 1 ? params.prompt : content
            }
          ],
          modalities: ['image', 'text']
        };

        // Add image_config for aspect ratio
        if (params.aspectRatio) {
          requestBody.image_config = {
            aspect_ratio: params.aspectRatio
          };
        }

        const result = await requestUrl({
          url: `${this.baseUrl}/chat/completions`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'HTTP-Referer': this.httpReferer,
            'X-Title': this.xTitle
          },
          body: JSON.stringify(requestBody)
        });

        return result.json;
      }, 2);

      return this.buildImageResponse(response, params);
    } catch (error) {
      this.handleImageError(error, 'image generation', params);
    }
  }

  /**
   * Load reference images from vault and convert to OpenRouter format
   */
  private async loadReferenceImages(paths: string[]): Promise<any[]> {
    if (!this.vault) {
      throw new Error('Vault not configured - cannot load reference images');
    }

    const parts: any[] = [];

    for (const path of paths) {
      try {
        const file = this.vault.getAbstractFileByPath(path);
        if (!file) {
          throw new Error(`Reference image not found: ${path}`);
        }

        // Read file as binary
        const arrayBuffer = await this.vault.readBinary(file as import('obsidian').TFile);
        const buffer = Buffer.from(arrayBuffer);
        const base64 = buffer.toString('base64');

        // Determine MIME type from extension
        const mimeType = this.getMimeType(path);

        // OpenRouter uses OpenAI-style image format
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${mimeType};base64,${base64}`
          }
        });
      } catch (error) {
        throw new Error(`Failed to load reference image ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return parts;
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(path: string): string {
    const ext = path.toLowerCase().split('.').pop() || '';
    const mimeTypes: Record<string, string> = {
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'bmp': 'image/bmp'
    };
    return mimeTypes[ext] || 'image/png';
  }

  /**
   * Validate OpenRouter-specific image generation parameters
   */
  validateImageParams(params: ImageGenerationParams): ImageValidationResult {
    const baseValidation = this.validateCommonParams(params);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const errors: string[] = [...baseValidation.errors];
    const warnings: string[] = [...(baseValidation.warnings || [])];
    const adjustedParams: Partial<ImageGenerationParams> = {};

    // Validate model
    const model = params.model || this.defaultModel;
    if (model && !this.modelMap[model]) {
      warnings.push(`Unknown model ${model}, will attempt to use as-is`);
    }

    // Validate aspect ratio
    if (params.aspectRatio && !this.openRouterAspectRatios.includes(params.aspectRatio)) {
      errors.push(`Invalid aspect ratio. Supported ratios: ${this.openRouterAspectRatios.join(', ')}`);
    }

    // Validate reference images
    if (params.referenceImages && params.referenceImages.length > 0) {
      // OpenRouter/Gemini supports up to 14 reference images
      if (params.referenceImages.length > 14) {
        errors.push('Too many reference images. Maximum is 14 reference images');
      }

      // Validate image extensions
      const validExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
      for (const path of params.referenceImages) {
        const ext = '.' + (path.toLowerCase().split('.').pop() || '');
        if (!validExtensions.includes(ext)) {
          errors.push(`Invalid reference image format: ${path}. Supported formats: ${validExtensions.join(', ')}`);
        }
      }
    }

    // Set default model if not specified
    if (!params.model) {
      adjustedParams.model = this.defaultModel;
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      adjustedParams
    };
  }

  /**
   * Get OpenRouter image capabilities
   */
  getImageCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: false,
      supportsJSON: false,
      supportsImages: true,
      supportsFunctions: false,
      supportsThinking: false,
      supportsImageGeneration: true,
      maxContextWindow: 32000,
      supportedFeatures: [
        'text_to_image',
        'image_to_image',
        'multi_reference_images',
        'aspect_ratio_control',
        'multiple_model_choice'
      ]
    };
  }

  /**
   * Get supported aspect ratios
   */
  getSupportedAspectRatios(): AspectRatio[] {
    return [
      AspectRatio.SQUARE,
      AspectRatio.PORTRAIT_2_3,
      AspectRatio.LANDSCAPE_3_2,
      AspectRatio.PORTRAIT_3_4,
      AspectRatio.LANDSCAPE_4_3,
      AspectRatio.PORTRAIT_4_5,
      AspectRatio.LANDSCAPE_5_4,
      AspectRatio.PORTRAIT_9_16,
      AspectRatio.LANDSCAPE_16_9,
      AspectRatio.ULTRAWIDE_21_9
    ];
  }

  /**
   * Get supported image sizes
   */
  getSupportedImageSizes(): string[] {
    return [...this.supportedSizes];
  }

  /**
   * Get pricing for OpenRouter image models
   * Note: OpenRouter pricing varies by underlying model
   */
  async getImageModelPricing(model: string = 'gemini-2.5-flash-image'): Promise<CostDetails> {
    // OpenRouter pricing is model-dependent
    // These are approximate prices - actual cost from OpenRouter API response
    const pricing: Record<string, number> = {
      'gemini-2.5-flash-image': 0.039,
      'gemini-3-pro-image-preview': 0.08,
      'flux-2-pro': 0.05,
      'flux-2-flex': 0.03
    };

    const basePrice = pricing[model] || 0.05;

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
   * List available OpenRouter image models
   */
  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'gemini-2.5-flash-image',
        name: 'Nano Banana (via OpenRouter)',
        contextWindow: 32000,
        maxOutputTokens: 0,
        supportsJSON: false,
        supportsImages: true,
        supportsFunctions: false,
        supportsStreaming: false,
        supportsThinking: false,
        supportsImageGeneration: true,
        pricing: {
          inputPerMillion: 0,
          outputPerMillion: 0,
          imageGeneration: 0.039,
          currency: 'USD',
          lastUpdated: '2025-12-07'
        }
      },
      {
        id: 'gemini-3-pro-image-preview',
        name: 'Nano Banana Pro (via OpenRouter)',
        contextWindow: 32000,
        maxOutputTokens: 0,
        supportsJSON: false,
        supportsImages: true,
        supportsFunctions: false,
        supportsStreaming: false,
        supportsThinking: false,
        supportsImageGeneration: true,
        pricing: {
          inputPerMillion: 0,
          outputPerMillion: 0,
          imageGeneration: 0.08,
          currency: 'USD',
          lastUpdated: '2025-12-07'
        }
      },
      {
        id: 'flux-2-pro',
        name: 'FLUX.2 Pro (via OpenRouter)',
        contextWindow: 4096,
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
          imageGeneration: 0.05,
          currency: 'USD',
          lastUpdated: '2025-12-07'
        }
      },
      {
        id: 'flux-2-flex',
        name: 'FLUX.2 Flex (via OpenRouter)',
        contextWindow: 4096,
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
          imageGeneration: 0.03,
          currency: 'USD',
          lastUpdated: '2025-12-07'
        }
      }
    ];
  }

  // Private helper methods

  private buildImageResponse(
    response: any,
    params: ImageGenerationParams
  ): ImageGenerationResponse {
    // OpenRouter response format:
    // { choices: [{ message: { content: "...", images: [{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }] } }] }

    if (!response.choices || response.choices.length === 0) {
      throw new Error('No response choices received from OpenRouter');
    }

    const message = response.choices[0].message;
    if (!message?.images || message.images.length === 0) {
      throw new Error('No images found in OpenRouter response');
    }

    const imageData = message.images[0];
    const imageUrl = imageData.image_url?.url || imageData.imageUrl?.url;

    if (!imageUrl) {
      throw new Error('No image URL found in OpenRouter response');
    }

    // Parse base64 data URL
    const matches = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) {
      throw new Error('Invalid image data URL format from OpenRouter');
    }

    const format = matches[1] as 'png' | 'jpeg' | 'webp';
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    // Extract dimensions from aspectRatio
    let width = 1024, height = 1024;
    let aspectRatio: AspectRatio = params.aspectRatio || AspectRatio.SQUARE;

    // Map aspect ratios to dimensions per OpenRouter docs
    const aspectRatioToDimensions: Record<string, [number, number]> = {
      '1:1': [1024, 1024],
      '2:3': [832, 1248],
      '3:2': [1248, 832],
      '3:4': [864, 1184],
      '4:3': [1184, 864],
      '4:5': [896, 1152],
      '5:4': [1152, 896],
      '9:16': [768, 1344],
      '16:9': [1344, 768],
      '21:9': [1536, 672]
    };

    if (params.aspectRatio && aspectRatioToDimensions[params.aspectRatio]) {
      [width, height] = aspectRatioToDimensions[params.aspectRatio];
    }

    const usage: ImageUsage = this.buildImageUsage(1, `${width}x${height}`, params.model || this.defaultModel);

    return {
      imageData: buffer,
      format: format,
      dimensions: { width, height },
      metadata: {
        aspectRatio,
        model: params.model || this.defaultModel,
        provider: this.name,
        generatedAt: new Date().toISOString(),
        originalPrompt: params.prompt,
        referenceImagesCount: params.referenceImages?.length || 0,
        openRouterModel: this.modelMap[params.model || this.defaultModel]
      },
      usage
    };
  }
}
