/**
 * Google Gemini Image Generation Adapter
 *
 * Nano Banana family through the Gemini generateContent REST API with
 * responseModalities ['TEXT', 'IMAGE'] and generationConfig.imageConfig.
 *
 * Model facts (ids, sizes, reference limits, prices) come from
 * https://ai.google.dev/gemini-api/docs/image-generation and
 * https://ai.google.dev/gemini-api/docs/pricing, checked against a live call.
 * The imageSize enum is "512" | "1K" | "2K" | "4K": Google accepts "512px"
 * without complaint and then renders and bills a 1K image, so the internal
 * '512px' value is mapped before sending.
 */

import { TFile, Vault } from 'obsidian';
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
  CostDetails,
  GenerateOptions,
  StreamChunk
} from '../types';
import { readImageDimensions, sniffImageFormat } from '../shared/imageDimensions';

type OutputFormat = 'png' | 'jpeg' | 'webp';
type GeminiImageSize = '512' | '1K' | '2K' | '4K';

interface GeminiImageModelSpec {
  displayName: string;
  /** USD for one 1K image (1120 output image tokens; 1290 for 2.5). */
  costPerImage: number;
  pricingNote: string;
  imageTokenPricePerMillion: number;
  maxReferenceImages: number;
  /** imageConfig.imageSize values the model accepts; null = no imageSize at all. */
  imageSizes: GeminiImageSize[] | null;
  contextWindow: number;
  lastUpdated: string;
}

// Type definitions for Google GenAI response structure
interface InlineData {
  mimeType: string;
  data: string;
}

interface ResponseContentPart {
  inlineData?: InlineData;
  text?: string;
}

interface Content {
  parts?: ResponseContentPart[];
}

interface Candidate {
  content?: Content;
}

interface GenerateContentResponseType {
  candidates?: Candidate[];
  modelVersion?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    candidatesTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
  };
}

interface RequestInlineData {
  mime_type: string;
  data: string;
}

interface RequestPart {
  inline_data?: RequestInlineData;
  text?: string;
}

interface RequestContent {
  parts: RequestPart[];
}

interface GenerationConfig {
  responseModalities: string[];
  imageConfig?: {
    aspectRatio?: string;
    imageSize?: GeminiImageSize;
  };
}

const IMAGE_SIZE_TO_GEMINI: Record<NanoBananaImageSize, GeminiImageSize> = {
  '512px': '512',
  '1K': '1K',
  '2K': '2K',
  '4K': '4K'
};

// Typical pixel dimensions per aspect ratio at 1K. Used only when the image
// header cannot be read — the real dimensions come from the bytes.
const ASPECT_RATIO_TO_DIMENSIONS: Record<string, [number, number]> = {
  '1:1': [1024, 1024],
  '2:3': [832, 1248],
  '3:2': [1248, 832],
  '3:4': [864, 1184],
  '4:3': [1184, 864],
  '4:5': [896, 1152],
  '5:4': [1152, 896],
  '9:16': [768, 1344],
  '16:9': [1344, 768],
  '21:9': [1536, 672],
  '1:4': [256, 1024],
  '4:1': [1024, 256],
  '1:8': [128, 1024],
  '8:1': [1024, 128]
};

export class GeminiImageAdapter extends BaseImageAdapter {

  // Image adapters don't support streaming in the same way as text
  async* generateStreamAsync(_prompt: string, _options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    await Promise.resolve();
    yield* [] as StreamChunk[];
    throw new Error('Image generation does not support streaming');
  }

  readonly name = 'gemini-image';
  readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  private readonly modelSpecs: Record<string, GeminiImageModelSpec> = {
    'gemini-3.1-flash-lite-image': {
      displayName: 'Nano Banana 2 Lite',
      costPerImage: 0.0336,
      pricingNote: '1120 image tokens at $30/M; 1K only',
      imageTokenPricePerMillion: 30,
      maxReferenceImages: 14,
      imageSizes: ['1K'],
      contextWindow: 65536,
      lastUpdated: '2026-09-02'
    },
    'gemini-3.1-flash-image': {
      displayName: 'Nano Banana 2',
      costPerImage: 0.067,
      pricingNote: '1120 image tokens at $60/M for 1K; 512 is $0.045, 2K $0.101, 4K $0.151',
      imageTokenPricePerMillion: 60,
      maxReferenceImages: 14,
      imageSizes: ['512', '1K', '2K', '4K'],
      contextWindow: 65536,
      lastUpdated: '2026-09-02'
    },
    'gemini-3-pro-image': {
      displayName: 'Nano Banana Pro',
      costPerImage: 0.134,
      pricingNote: '1120 image tokens at $120/M for 1K or 2K; 4K is $0.24',
      imageTokenPricePerMillion: 120,
      maxReferenceImages: 14,
      imageSizes: ['1K', '2K', '4K'],
      contextWindow: 131072,
      lastUpdated: '2026-09-02'
    },
    // Preview ids. Google's deprecation page lists a 2026-06-25 shutdown for
    // both, but the API still serves them; kept so saved settings keep working.
    'gemini-3.1-flash-image-preview': {
      displayName: 'Nano Banana 2 preview',
      costPerImage: 0.067,
      pricingNote: 'Same pricing as gemini-3.1-flash-image',
      imageTokenPricePerMillion: 60,
      maxReferenceImages: 14,
      imageSizes: ['512', '1K', '2K', '4K'],
      contextWindow: 65536,
      lastUpdated: '2026-09-02'
    },
    'gemini-3-pro-image-preview': {
      displayName: 'Nano Banana Pro preview',
      costPerImage: 0.134,
      pricingNote: 'Same pricing as gemini-3-pro-image',
      imageTokenPricePerMillion: 120,
      maxReferenceImages: 14,
      imageSizes: ['1K', '2K', '4K'],
      contextWindow: 131072,
      lastUpdated: '2026-09-02'
    },
    'gemini-2.5-flash-image': {
      displayName: 'Nano Banana legacy, shuts down 2026-10-02',
      costPerImage: 0.039,
      pricingNote: '1290 image tokens at $30/M; no imageSize parameter',
      imageTokenPricePerMillion: 30,
      maxReferenceImages: 3,
      imageSizes: null,
      contextWindow: 32768,
      lastUpdated: '2026-09-02'
    }
  };

  readonly supportedModels: ImageModel[] = Object.keys(this.modelSpecs) as ImageModel[];
  readonly supportedSizes: string[] = ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'];
  readonly supportedFormats: string[] = ['png', 'jpeg', 'webp'];

  private vault: Vault | null = null;
  // gemini-2.5-flash-image is scheduled for shutdown on 2026-10-02; Google
  // recommends Nano Banana 2 Lite as the transition.
  private readonly defaultModel = 'gemini-3.1-flash-image';

  // Supported aspect ratios for Nano Banana models
  private readonly nanoBananaAspectRatios: string[] = [
    '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
    '1:4', '4:1', '1:8', '8:1'
  ];

  constructor(config?: ProviderConfig & { vault?: Vault }) {
    const apiKey = config?.apiKey || '';
    super(apiKey, 'gemini-3.1-flash-image', config?.baseUrl);

    if (config?.vault) {
      this.vault = config.vault;
    }

    this.initializeCache();
  }

  /**
   * Set vault for reading reference images
   */
  setVault(vault: Vault): void {
    this.vault = vault;
  }

  /**
   * Generate one image through models/<id>:generateContent.
   */
  async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResponse> {
    try {
      this.validateConfiguration();

      const model = params.model || this.defaultModel;
      const spec = this.modelSpecs[model];
      if (!spec) {
        throw new Error(`Unknown Gemini image model: ${model}. Supported models: ${this.supportedModels.join(', ')}`);
      }

      // Raw REST requests use contents[].parts[] rather than a flat contents[] array.
      const parts: RequestPart[] = [{ text: params.prompt }];

      if (params.referenceImages && params.referenceImages.length > 0) {
        parts.push(...await this.loadReferenceImages(params.referenceImages));
      }

      const generationConfig: GenerationConfig = {
        responseModalities: ['TEXT', 'IMAGE']
      };

      const imageConfig: GenerationConfig['imageConfig'] = {};
      if (params.aspectRatio) {
        imageConfig.aspectRatio = params.aspectRatio;
      }
      // Only models that declare imageSize accept one, and the wire value for
      // '512px' is '512' — the '512px' spelling is silently rendered at 1K.
      if (params.imageSize && spec.imageSizes) {
        imageConfig.imageSize = IMAGE_SIZE_TO_GEMINI[params.imageSize];
      }
      if (Object.keys(imageConfig).length > 0) {
        generationConfig.imageConfig = imageConfig;
      }

      // Retries cover 408/409/429/5xx only; a 4xx rejection is final.
      const result = await this.request<GenerateContentResponseType>({
        url: `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
        operation: 'image generation',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey
        },
        body: JSON.stringify({
          contents: [{ parts }] satisfies RequestContent[],
          generationConfig
        }),
        timeoutMs: 120_000,
        retries: 2
      });

      this.assertOk(result, `Google image generation failed: HTTP ${result.status}`);

      if (!result.json) {
        throw new Error('No response returned from Google image generation');
      }

      return this.buildImageResponse(result.json, params, model, spec);
    } catch (error) {
      this.handleImageError(error, 'image generation', params);
    }
  }

  /**
   * Load reference images from vault and convert to base64
   */
  private async loadReferenceImages(paths: string[]): Promise<RequestPart[]> {
    if (!this.vault) {
      throw new Error('Vault not configured - cannot load reference images');
    }

    const parts: RequestPart[] = [];

    for (const path of paths) {
      try {
        const file = this.vault.getAbstractFileByPath(path);
        if (!file) {
          throw new Error(`Reference image not found: ${path}`);
        }

        // Type guard: ensure file is a TFile (not a TFolder)
        if (!(file instanceof TFile)) {
          throw new Error(`Reference path is not a file: ${path}`);
        }

        const arrayBuffer = await this.vault.readBinary(file);
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        const mimeType = this.getMimeType(path);

        parts.push({
          inline_data: {
            mime_type: mimeType,
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
    const baseValidation = this.validateCommonParams(params);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    const errors: string[] = [...baseValidation.errors];
    const warnings: string[] = [...(baseValidation.warnings || [])];
    const adjustedParams: Partial<ImageGenerationParams> = {};

    const model = params.model || this.defaultModel;
    const spec = this.modelSpecs[model];
    if (!spec) {
      errors.push(`Invalid model. Supported models: ${this.supportedModels.join(', ')}`);
      return { isValid: false, errors, warnings, adjustedParams };
    }

    if (params.aspectRatio && !this.nanoBananaAspectRatios.includes(params.aspectRatio)) {
      errors.push(`Invalid aspect ratio. Supported ratios: ${this.nanoBananaAspectRatios.join(', ')}`);
    }

    if (params.imageSize) {
      const wireValue = IMAGE_SIZE_TO_GEMINI[params.imageSize];
      if (!wireValue) {
        errors.push('imageSize must be "512px", "1K", "2K", or "4K"');
      } else if (!spec.imageSizes) {
        warnings.push(`${model} does not take an imageSize; ${params.imageSize} ignored`);
        adjustedParams.imageSize = undefined;
      } else if (!spec.imageSizes.includes(wireValue)) {
        const supported = spec.imageSizes.map(s => (s === '512' ? '512px' : s)).join(', ');
        errors.push(`imageSize ${params.imageSize} is not available for ${model}. Supported: ${supported}`);
      }
    }

    if (params.numberOfImages && (params.numberOfImages < 1 || params.numberOfImages > 4)) {
      errors.push('numberOfImages must be between 1 and 4');
    }

    if (params.referenceImages && params.referenceImages.length > 0) {
      if (params.referenceImages.length > spec.maxReferenceImages) {
        errors.push(`Too many reference images. ${model} supports max ${spec.maxReferenceImages} reference images`);
      }

      const validExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
      for (const path of params.referenceImages) {
        const ext = '.' + (path.toLowerCase().split('.').pop() || '');
        if (!validExtensions.includes(ext)) {
          errors.push(`Invalid reference image format: ${path}. Supported formats: ${validExtensions.join(', ')}`);
        }
      }
    }

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
      maxContextWindow: 32000,
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
      AspectRatio.ULTRAWIDE_21_9,
      AspectRatio.NARROW_1_4,
      AspectRatio.WIDE_4_1,
      AspectRatio.ULTRA_NARROW_1_8,
      AspectRatio.ULTRA_WIDE_8_1
    ];
  }

  /**
   * Get supported image sizes
   */
  getSupportedImageSizes(): string[] {
    return [...this.supportedSizes];
  }

  /**
   * List price for one 1K image. The actual charge is computed from the
   * response's image token count and recorded as `metadata.reportedCostUsd`.
   */
  getImageModelPricing(model = 'gemini-3.1-flash-image'): Promise<CostDetails> {
    const basePrice = this.modelSpecs[model]?.costPerImage ?? 0.039;

    return Promise.resolve({
      inputCost: 0,
      outputCost: basePrice,
      totalCost: basePrice,
      currency: 'USD',
      rateInputPerMillion: 0,
      rateOutputPerMillion: basePrice * 1_000_000
    });
  }

  /**
   * List available Nano Banana image models
   */
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(
      Object.entries(this.modelSpecs).map(([id, spec]) => ({
        id,
        name: spec.displayName,
        contextWindow: spec.contextWindow,
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
          imageGeneration: spec.costPerImage,
          currency: 'USD',
          lastUpdated: spec.lastUpdated
        }
      }))
    );
  }

  // Private helper methods

  private buildImageResponse(
    response: GenerateContentResponseType,
    params: ImageGenerationParams,
    model: string,
    spec: GeminiImageModelSpec
  ): ImageGenerationResponse {
    if (!response.candidates || response.candidates.length === 0) {
      throw new Error('No response candidates received from Google');
    }

    const candidate = response.candidates[0];
    if (!candidate.content || !candidate.content.parts) {
      throw new Error('No content parts in Google response');
    }

    const imagePart = candidate.content.parts.find((part: ResponseContentPart) => part.inlineData);
    if (!imagePart || !imagePart.inlineData) {
      throw new Error('No image data found in Google response');
    }

    const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
    const format = this.resolveFormat(imagePart.inlineData.mimeType, buffer);

    const aspectRatio: AspectRatio = params.aspectRatio || AspectRatio.SQUARE;
    const dimensions = readImageDimensions(buffer) || this.dimensionsForAspectRatio(aspectRatio);

    const usage: ImageUsage = this.buildImageUsage(1, `${dimensions.width}x${dimensions.height}`, model);

    const imageTokens = response.usageMetadata?.candidatesTokensDetails
      ?.find(detail => detail.modality === 'IMAGE')?.tokenCount;
    const reportedCostUsd = imageTokens !== undefined
      ? (imageTokens * spec.imageTokenPricePerMillion) / 1_000_000
      : undefined;

    return {
      imageData: buffer,
      format,
      dimensions,
      metadata: {
        aspectRatio,
        imageSize: params.imageSize,
        model,
        modelVersion: response.modelVersion,
        provider: this.name,
        generatedAt: new Date().toISOString(),
        originalPrompt: params.prompt,
        referenceImagesCount: params.referenceImages?.length || 0,
        mimeType: imagePart.inlineData.mimeType,
        imageTokens,
        reportedCostUsd,
        synthidWatermarking: true // Nano Banana adds SynthID watermarking
      },
      usage
    };
  }

  private resolveFormat(mimeType: string | undefined, buffer: Buffer): OutputFormat {
    const fromMime = mimeType?.toLowerCase().split('/')[1];
    if (fromMime === 'png' || fromMime === 'jpeg' || fromMime === 'webp') {
      return fromMime;
    }
    if (fromMime === 'jpg') {
      return 'jpeg';
    }
    return sniffImageFormat(buffer) || 'png';
  }

  private dimensionsForAspectRatio(aspectRatio: string): { width: number; height: number } {
    const [width, height] = ASPECT_RATIO_TO_DIMENSIONS[aspectRatio] || [1024, 1024];
    return { width, height };
  }
}
