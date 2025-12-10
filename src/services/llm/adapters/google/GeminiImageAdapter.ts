/**
 * Google Gemini Image Generation Adapter
 * Supports Google's Nano Banana models for image generation
 * - gemini-2.5-flash-image (Nano Banana) - fast generation
 * - gemini-3-pro-image-preview (Nano Banana Pro) - advanced with reference images
 *
 * Uses generateContent() API with responseModalities: ['TEXT', 'IMAGE']
 *
 * MOBILE COMPATIBILITY (Dec 2025):
 * The @google/genai SDK uses gaxios which requires Node.js 'os' module.
 * SDK import is now lazy (dynamic) to avoid bundling Node.js dependencies.
 */

import { Vault } from 'obsidian';

// Type-only import for TypeScript (doesn't affect bundling)
import type { GoogleGenAI as GoogleGenAIType } from '@google/genai';
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

export class GeminiImageAdapter extends BaseImageAdapter {

  // Image adapters don't support streaming in the same way as text
  async* generateStreamAsync(): AsyncGenerator<never, void, unknown> {
    throw new Error('Image generation does not support streaming');
  }

  readonly name = 'gemini-image';
  readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  readonly supportedModels: ImageModel[] = ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview'];
  readonly supportedSizes: string[] = ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'];
  readonly supportedFormats: string[] = ['png', 'jpeg', 'webp'];

  private client: GoogleGenAIType | null = null;
  private clientPromise: Promise<GoogleGenAIType> | null = null;
  private vault: Vault | null = null;
  private readonly defaultModel = 'gemini-2.5-flash-image';

  // Max reference images per model
  private readonly maxReferenceImages = {
    'gemini-2.5-flash-image': 6,
    'gemini-3-pro-image-preview': 14
  };

  // Supported aspect ratios for Nano Banana models
  private readonly nanoBananaAspectRatios = [
    '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'
  ];

  constructor(config?: ProviderConfig & { vault?: Vault }) {
    const apiKey = config?.apiKey || '';
    super(apiKey, 'gemini-2.5-flash-image', config?.baseUrl);

    if (config?.vault) {
      this.vault = config.vault;
    }

    this.initializeCache();
  }

  /**
   * Lazy-load the Google GenAI SDK to avoid bundling Node.js dependencies
   */
  private async getClient(): Promise<GoogleGenAIType> {
    if (this.client) {
      return this.client;
    }

    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { GoogleGenAI } = await import('@google/genai');
        this.client = new GoogleGenAI({ apiKey: this.apiKey });
        return this.client;
      })();
    }

    return this.clientPromise;
  }

  /**
   * Set vault for reading reference images
   */
  setVault(vault: Vault): void {
    this.vault = vault;
  }

  /**
   * Generate images using Google's Nano Banana models
   * Uses generateContent() API with responseModalities: ['TEXT', 'IMAGE']
   */
  async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResponse> {
    try {
      this.validateConfiguration();

      const model = params.model || this.defaultModel;

      const response = await this.withRetry(async () => {
        // Build contents array with prompt and reference images
        const contents: any[] = [{ text: params.prompt }];

        // Add reference images if provided
        if (params.referenceImages && params.referenceImages.length > 0) {
          const referenceImageParts = await this.loadReferenceImages(params.referenceImages);
          contents.push(...referenceImageParts);
        }

        // Build config
        const config: any = {
          responseModalities: ['TEXT', 'IMAGE'],
        };

        // Add image config if aspect ratio or size specified
        const imageConfig: any = {};
        if (params.aspectRatio) {
          imageConfig.aspectRatio = params.aspectRatio;
        }
        // Use imageSize or fall back to sampleImageSize (legacy)
        const imageSize = params.imageSize || params.sampleImageSize;
        if (imageSize) {
          imageConfig.imageSize = imageSize;
        }
        if (Object.keys(imageConfig).length > 0) {
          config.imageConfig = imageConfig;
        }

        // Call generateContent API
        const client = await this.getClient();
        const result = await (client as any).models.generateContent({
          model: model,
          contents: contents,
          config: config
        });

        return result;
      }, 2);

      return this.buildImageResponse(response, params);
    } catch (error) {
      this.handleImageError(error, 'image generation', params);
    }
  }

  /**
   * Load reference images from vault and convert to base64
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
        const arrayBuffer = await this.vault.readBinary(file as any);
        const buffer = Buffer.from(arrayBuffer);
        const base64 = buffer.toString('base64');

        // Determine MIME type from extension
        const mimeType = this.getMimeType(path);

        parts.push({
          inlineData: {
            mimeType: mimeType,
            data: base64
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
   * Validate Nano Banana-specific image generation parameters
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

    // Validate model
    const model = params.model || this.defaultModel;
    if (!this.supportedModels.includes(model as ImageModel)) {
      errors.push(`Invalid model. Supported models: ${this.supportedModels.join(', ')}`);
    }

    // Validate aspect ratio
    if (params.aspectRatio && !this.nanoBananaAspectRatios.includes(params.aspectRatio)) {
      errors.push(`Invalid aspect ratio. Supported ratios: ${this.nanoBananaAspectRatios.join(', ')}`);
    }

    // Validate image size
    const imageSize = params.imageSize || params.sampleImageSize;
    if (imageSize) {
      const validSizes = ['1K', '2K', '4K'];
      if (!validSizes.includes(imageSize)) {
        errors.push('imageSize must be "1K", "2K", or "4K"');
      }
      // 4K only available for Pro model
      if (imageSize === '4K' && model !== 'gemini-3-pro-image-preview') {
        errors.push('4K resolution is only available for gemini-3-pro-image-preview model');
      }
    }

    // Validate number of images
    if (params.numberOfImages && (params.numberOfImages < 1 || params.numberOfImages > 4)) {
      errors.push('numberOfImages must be between 1 and 4');
    }

    // Validate reference images
    if (params.referenceImages && params.referenceImages.length > 0) {
      const maxRefs = this.maxReferenceImages[model as keyof typeof this.maxReferenceImages] || 6;
      if (params.referenceImages.length > maxRefs) {
        errors.push(`Too many reference images. ${model} supports max ${maxRefs} reference images`);
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
   * Get Nano Banana capabilities
   */
  getImageCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: false,
      supportsJSON: false,
      supportsImages: true, // Supports reference images
      supportsFunctions: false,
      supportsThinking: false,
      supportsImageGeneration: true,
      maxContextWindow: 32000, // Higher limit for Nano Banana
      supportedFeatures: [
        'text_to_image',
        'image_to_image',
        'multi_reference_images',
        'aspect_ratio_control',
        'high_quality_output',
        'enhanced_text_rendering',
        '4k_resolution'
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
   * Get pricing for Nano Banana models (2025 pricing)
   */
  async getImageModelPricing(model: string = 'gemini-2.5-flash-image'): Promise<CostDetails> {
    const pricing: Record<string, number> = {
      'gemini-2.5-flash-image': 0.039,      // Nano Banana
      'gemini-3-pro-image-preview': 0.08    // Nano Banana Pro (estimate)
    };

    const basePrice = pricing[model] || 0.039;

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
   * List available Nano Banana image models
   */
  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'gemini-2.5-flash-image',
        name: 'Nano Banana (Fast)',
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
        name: 'Nano Banana Pro (Advanced)',
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
      }
    ];
  }

  // Private helper methods

  private buildImageResponse(
    response: any,
    params: ImageGenerationParams
  ): ImageGenerationResponse {
    // Handle generateContent response format
    // Response structure: { candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }] }

    if (!response.candidates || response.candidates.length === 0) {
      throw new Error('No response candidates received from Google');
    }

    const candidate = response.candidates[0];
    if (!candidate.content || !candidate.content.parts) {
      throw new Error('No content parts in Google response');
    }

    // Find the image part in the response
    const imagePart = candidate.content.parts.find((part: any) => part.inlineData);
    if (!imagePart || !imagePart.inlineData) {
      throw new Error('No image data found in Google response');
    }

    // Convert base64 to buffer
    const buffer = Buffer.from(imagePart.inlineData.data, 'base64');

    // Determine format from MIME type
    const mimeType = imagePart.inlineData.mimeType || 'image/png';
    const format = mimeType.split('/')[1] as 'png' | 'jpeg' | 'webp' || 'png';

    // Extract dimensions from aspectRatio
    let width = 1024, height = 1024;
    let aspectRatio: AspectRatio = params.aspectRatio || AspectRatio.SQUARE;

    // Map aspect ratios to typical dimensions
    const aspectRatioToDimensions: Record<string, [number, number]> = {
      '1:1': [1024, 1024],
      '2:3': [768, 1152],
      '3:2': [1152, 768],
      '3:4': [896, 1152],
      '4:3': [1152, 896],
      '4:5': [896, 1120],
      '5:4': [1120, 896],
      '9:16': [576, 1024],
      '16:9': [1024, 576],
      '21:9': [1344, 576]
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
        synthidWatermarking: true // Nano Banana adds SynthID watermarking
      },
      usage
    };
  }
}
