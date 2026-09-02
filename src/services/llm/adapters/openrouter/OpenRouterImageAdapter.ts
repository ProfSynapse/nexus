/**
 * OpenRouter Image Generation Adapter
 *
 * Speaks OpenRouter's dedicated Image API (POST /api/v1/images), the only
 * transport that serves every image model on the platform. The older
 * chat-completions route (`modalities: ['image', 'text']`) still works for
 * Google and OpenAI text+image models but returns 404 for image-only models
 * such as FLUX, and OpenRouter adds new image models to the Image API only.
 *
 * Catalog: https://openrouter.ai/api/v1/images/models
 * Per-model parameters and pricing: /api/v1/images/models/<id>/endpoints
 */

import { Vault } from 'obsidian';
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
import { BRAND_NAME } from '../../../../constants/branding';

type OutputFormat = 'png' | 'jpeg' | 'webp';

/** OpenRouter's `resolution` enum. Our `imageSize` uses '512px' for the first. */
type OpenRouterResolution = '512' | '1K' | '2K' | '4K';

/**
 * Everything the adapter needs to know about one model, sourced from
 * /api/v1/images/models/<id>/endpoints. `resolutions` is null when the
 * endpoint has no `resolution` parameter — sending one is a hard 400.
 */
interface OpenRouterImageModelSpec {
  openRouterId: string;
  displayName: string;
  /** USD for one image at the default resolution (1K / 1 megapixel). */
  costPerImage: number;
  pricingNote: string;
  maxReferenceImages: number;
  resolutions: OpenRouterResolution[] | null;
  contextWindow: number;
  lastUpdated: string;
}

interface OpenRouterImageReference {
  type: 'image_url';
  image_url: { url: string };
}

interface OpenRouterImagesRequestBody {
  model: string;
  prompt: string;
  aspect_ratio?: AspectRatio;
  resolution?: OpenRouterResolution;
  input_references?: OpenRouterImageReference[];
}

interface OpenRouterImagesResponse {
  created?: number;
  data?: Array<{
    b64_json?: string;
    media_type?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    completion_tokens_details?: {
      image_tokens?: number;
    };
  };
}

const IMAGE_SIZE_TO_RESOLUTION: Record<NanoBananaImageSize, OpenRouterResolution> = {
  '512px': '512',
  '1K': '1K',
  '2K': '2K',
  '4K': '4K'
};

const MEDIA_TYPE_TO_FORMAT: Record<string, OutputFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/webp': 'webp'
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

/**
 * Read width and height from a PNG, JPEG or WebP header. Returns null when
 * the bytes are not one of those or the header is truncated.
 */
export function readImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  // PNG: signature, then IHDR with width/height as big-endian u32 at 16 and 20.
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // JPEG: walk segments to the first start-of-frame marker.
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 <= buffer.length) {
      if (buffer[offset] !== 0xff) {
        return null;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2; // standalone marker, no length
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (length < 2) {
        return null;
      }
      offset += 2 + length;
    }
    return null;
  }

  // WebP: RIFF....WEBP then a VP8 / VP8L / VP8X chunk.
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return {
        width: (buffer.readUIntLE(24, 3)) + 1,
        height: (buffer.readUIntLE(27, 3)) + 1
      };
    }
  }

  return null;
}

export class OpenRouterImageAdapter extends BaseImageAdapter {

  async* generateStreamAsync(_prompt: string, _options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    await Promise.resolve();
    yield* [] as StreamChunk[];
    throw new Error('Image generation does not support streaming');
  }

  readonly name = 'openrouter-image';
  readonly baseUrl = 'https://openrouter.ai/api/v1';

  /**
   * Model catalog. Every value comes from the model's own
   * /api/v1/images/models/<id>/endpoints entry. Gemini bills per output token
   * (a 1K image is 1120 tokens); FLUX bills per megapixel; OpenAI bills per
   * output token at the provider's default (high) quality.
   */
  private readonly modelSpecs: Record<string, OpenRouterImageModelSpec> = {
    'gemini-2.5-flash-image': {
      // The earlier `google/gemini-2.5-flash-image-preview` id was retired and
      // now answers "No endpoints found".
      openRouterId: 'google/gemini-2.5-flash-image',
      displayName: 'Nano Banana (via OpenRouter)',
      costPerImage: 0.039,
      pricingNote: '1290 output tokens at $30/M',
      maxReferenceImages: 3,
      resolutions: null,
      contextWindow: 32768,
      lastUpdated: '2026-09-02'
    },
    'gemini-3-pro-image-preview': {
      openRouterId: 'google/gemini-3-pro-image-preview',
      displayName: 'Nano Banana Pro (via OpenRouter)',
      costPerImage: 0.134,
      pricingNote: '1120 output tokens at $120/M for 1K or 2K; 4K is double',
      maxReferenceImages: 14,
      resolutions: ['1K', '2K', '4K'],
      contextWindow: 65536,
      lastUpdated: '2026-09-02'
    },
    'gemini-3.1-flash-image-preview': {
      openRouterId: 'google/gemini-3.1-flash-image-preview',
      displayName: 'Nano Banana 2 (via OpenRouter)',
      costPerImage: 0.067,
      pricingNote: '1120 output tokens at $60/M for 1K or 2K; 4K is double',
      maxReferenceImages: 14,
      resolutions: ['512', '1K', '2K', '4K'],
      contextWindow: 65536,
      lastUpdated: '2026-09-02'
    },
    'gpt-5-image': {
      openRouterId: 'openai/gpt-5-image',
      displayName: 'GPT-5 Image (via OpenRouter)',
      costPerImage: 0.167,
      pricingNote: '4160 output tokens at $40/M at the default high quality',
      maxReferenceImages: 16,
      resolutions: null,
      contextWindow: 400000,
      lastUpdated: '2026-09-02'
    },
    'gpt-5.4-image-2': {
      openRouterId: 'openai/gpt-5.4-image-2',
      displayName: 'GPT-5.4 Image 2 (via OpenRouter)',
      costPerImage: 0.125,
      pricingNote: '4160 output tokens at $30/M at the default high quality',
      maxReferenceImages: 16,
      resolutions: null,
      contextWindow: 272000,
      lastUpdated: '2026-09-02'
    },
    'flux-2-pro': {
      openRouterId: 'black-forest-labs/flux.2-pro',
      displayName: 'FLUX.2 Pro (via OpenRouter)',
      costPerImage: 0.03,
      pricingNote: '$0.03 per output megapixel',
      maxReferenceImages: 8,
      resolutions: null,
      contextWindow: 4096,
      lastUpdated: '2026-09-02'
    },
    'flux-2-flex': {
      openRouterId: 'black-forest-labs/flux.2-flex',
      displayName: 'FLUX.2 Flex (via OpenRouter)',
      costPerImage: 0.06,
      pricingNote: '$0.06 per output megapixel, plus $0.06 per input megapixel',
      maxReferenceImages: 8,
      resolutions: null,
      contextWindow: 4096,
      lastUpdated: '2026-09-02'
    },
    'flux-2-klein-4b': {
      openRouterId: 'black-forest-labs/flux.2-klein-4b',
      displayName: 'FLUX.2 Klein 4B (via OpenRouter)',
      costPerImage: 0.014,
      pricingNote: '$0.014 per output megapixel; exactly one image per request',
      maxReferenceImages: 4,
      resolutions: null,
      contextWindow: 4096,
      lastUpdated: '2026-09-02'
    },
    // GA ids for the Gemini image family. The -preview ids above still resolve
    // but Google retires previews (2.5's is already gone), so prefer these.
    'gemini-3.1-flash-image': {
      openRouterId: 'google/gemini-3.1-flash-image',
      displayName: 'Nano Banana 2 GA (via OpenRouter)',
      costPerImage: 0.067,
      pricingNote: '1120 output tokens at $60/M for 1K or 2K; 4K is double',
      maxReferenceImages: 14,
      resolutions: ['512', '1K', '2K', '4K'],
      contextWindow: 65536,
      lastUpdated: '2026-09-02'
    },
    'gemini-3.1-flash-lite-image': {
      openRouterId: 'google/gemini-3.1-flash-lite-image',
      displayName: 'Nano Banana 2 Lite (via OpenRouter)',
      costPerImage: 0.034,
      pricingNote: '1120 output tokens at $30/M; 1K only',
      maxReferenceImages: 14,
      resolutions: ['1K'],
      contextWindow: 65536,
      lastUpdated: '2026-09-02'
    },
    'gemini-3-pro-image': {
      openRouterId: 'google/gemini-3-pro-image',
      displayName: 'Nano Banana Pro GA (via OpenRouter)',
      costPerImage: 0.134,
      pricingNote: '1120 output tokens at $120/M for 1K or 2K; 4K is double',
      maxReferenceImages: 14,
      resolutions: ['1K', '2K', '4K'],
      contextWindow: 65536,
      lastUpdated: '2026-09-02'
    },
    'gpt-5-image-mini': {
      openRouterId: 'openai/gpt-5-image-mini',
      displayName: 'GPT-5 Image Mini (via OpenRouter)',
      costPerImage: 0.033,
      pricingNote: '4160 output tokens at $8/M at the default high quality',
      maxReferenceImages: 16,
      resolutions: null,
      contextWindow: 400000,
      lastUpdated: '2026-09-02'
    },
    'gpt-image-2': {
      // OpenRouter's recommended replacement for the gpt-5-image chat models.
      openRouterId: 'openai/gpt-image-2',
      displayName: 'GPT Image 2 (via OpenRouter)',
      costPerImage: 0.125,
      pricingNote: '4160 output tokens at $30/M at the default high quality',
      maxReferenceImages: 16,
      resolutions: null,
      contextWindow: 32000,
      lastUpdated: '2026-09-02'
    },
    'seedream-4.5': {
      openRouterId: 'bytedance-seed/seedream-4.5',
      displayName: 'Seedream 4.5 (via OpenRouter)',
      costPerImage: 0.04,
      pricingNote: '$0.04 per image at any resolution',
      maxReferenceImages: 14,
      // The endpoint lists 1K, but OpenRouter rejects it: the model needs at
      // least 3,686,400 output pixels, so 2K is the real minimum.
      resolutions: ['2K', '4K'],
      contextWindow: 32000,
      lastUpdated: '2026-09-02'
    },
    'seedream-5-lite': {
      openRouterId: 'bytedance-seed/seedream-5-0-lite',
      displayName: 'Seedream 5.0 Lite (via OpenRouter)',
      costPerImage: 0.035,
      pricingNote: '$0.035 per image; 2K and 4K only',
      maxReferenceImages: 14,
      resolutions: ['2K', '4K'],
      contextWindow: 32000,
      lastUpdated: '2026-09-02'
    }
  };

  readonly supportedModels: ImageModel[] = Object.keys(this.modelSpecs) as ImageModel[];
  readonly supportedSizes: string[] = ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'];
  readonly supportedFormats: string[] = ['png', 'jpeg', 'webp'];

  private vault: Vault | null = null;
  private httpReferer: string;
  private xTitle: string;

  private readonly defaultModel = 'gemini-2.5-flash-image';

  // Aspect ratios accepted across the catalog. Individual endpoints may
  // support fewer; OpenRouter rejects those with a 400 naming the parameter.
  private readonly openRouterAspectRatios: string[] = [
    '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
    '1:4', '4:1', '1:8', '8:1'
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
   * Generate one image through POST /api/v1/images.
   */
  async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResponse> {
    try {
      this.validateConfiguration();

      const model = params.model || this.defaultModel;
      const spec = this.modelSpecs[model];
      if (!spec) {
        throw new Error(`Unknown OpenRouter image model: ${model}. Supported models: ${this.supportedModels.join(', ')}`);
      }

      const requestBody: OpenRouterImagesRequestBody = {
        model: spec.openRouterId,
        prompt: params.prompt
      };

      if (params.aspectRatio) {
        requestBody.aspect_ratio = params.aspectRatio;
      }

      // Only endpoints that declare a `resolution` parameter accept one.
      if (params.imageSize && spec.resolutions) {
        requestBody.resolution = IMAGE_SIZE_TO_RESOLUTION[params.imageSize];
      }

      if (params.referenceImages && params.referenceImages.length > 0) {
        requestBody.input_references = await this.loadReferenceImages(params.referenceImages);
      }

      // Retries cover 408/409/429/5xx only; a 4xx parameter rejection or a
      // moderation block is final and must not be paid for twice.
      const result = await this.request<OpenRouterImagesResponse>({
        url: `${this.baseUrl}/images`,
        operation: 'image generation',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': this.httpReferer,
          'X-Title': this.xTitle
        },
        body: JSON.stringify(requestBody),
        timeoutMs: 120_000,
        retries: 2
      });

      this.assertOk(result, `OpenRouter image generation failed: HTTP ${result.status}`);

      if (!result.json) {
        throw new Error('No response returned from OpenRouter image generation');
      }

      return this.buildImageResponse(result.json, params, spec);
    } catch (error) {
      this.handleImageError(error, 'image generation', params);
    }
  }

  /**
   * Load reference images from the vault as data-URL `input_references`.
   */
  private async loadReferenceImages(paths: string[]): Promise<OpenRouterImageReference[]> {
    if (!this.vault) {
      throw new Error('Vault not configured - cannot load reference images');
    }

    const references: OpenRouterImageReference[] = [];

    for (const path of paths) {
      try {
        const file = this.vault.getAbstractFileByPath(path);
        if (!file) {
          throw new Error(`Reference image not found: ${path}`);
        }

        const arrayBuffer = await this.vault.readBinary(file as import('obsidian').TFile);
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        const mimeType = this.getMimeType(path);

        references.push({
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${base64}` }
        });
      } catch (error) {
        throw new Error(`Failed to load reference image ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return references;
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

    const model = params.model || this.defaultModel;
    const spec = this.modelSpecs[model];
    if (!spec) {
      errors.push(`Unknown model ${model}. Supported models: ${this.supportedModels.join(', ')}`);
      return { isValid: false, errors, warnings, adjustedParams };
    }

    if (params.aspectRatio && !this.openRouterAspectRatios.includes(params.aspectRatio)) {
      errors.push(`Invalid aspect ratio. Supported ratios: ${this.openRouterAspectRatios.join(', ')}`);
    }

    if (params.imageSize) {
      if (!spec.resolutions) {
        warnings.push(`${model} does not take a resolution; imageSize ${params.imageSize} ignored`);
        adjustedParams.imageSize = undefined;
      } else if (!spec.resolutions.includes(IMAGE_SIZE_TO_RESOLUTION[params.imageSize])) {
        const supported = spec.resolutions.map(r => (r === '512' ? '512px' : r)).join(', ');
        errors.push(`imageSize ${params.imageSize} is not available for ${model}. Supported: ${supported}`);
      }
    }

    if (params.numberOfImages && params.numberOfImages > 1) {
      warnings.push('OpenRouter image generation produces one image per request; numberOfImages ignored');
    }

    if (params.referenceImages && params.referenceImages.length > 0) {
      if (params.referenceImages.length > spec.maxReferenceImages) {
        errors.push(`Too many reference images for ${model}. Maximum is ${spec.maxReferenceImages}`);
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
   * Per-image list price at the default resolution. The actual charge is in
   * the response's `usage.cost` and is recorded as `metadata.reportedCostUsd`.
   */
  getImageModelPricing(model = 'gemini-2.5-flash-image'): Promise<CostDetails> {
    const basePrice = this.modelSpecs[model]?.costPerImage ?? 0.05;

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
   * List available OpenRouter image models
   */
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(
      Object.entries(this.modelSpecs).map(([id, spec]) => ({
        id,
        name: spec.displayName,
        contextWindow: spec.contextWindow,
        maxOutputTokens: 0,
        supportsJSON: false,
        supportsImages: spec.maxReferenceImages > 0,
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
    response: OpenRouterImagesResponse,
    params: ImageGenerationParams,
    spec: OpenRouterImageModelSpec
  ): ImageGenerationResponse {
    const item = response.data?.[0];
    if (!item?.b64_json) {
      throw new Error('No image data in OpenRouter response');
    }

    const buffer = Buffer.from(item.b64_json, 'base64');
    const format = this.resolveFormat(item.media_type, buffer);

    const aspectRatio: AspectRatio = params.aspectRatio || AspectRatio.SQUARE;
    const dimensions = readImageDimensions(buffer) || this.dimensionsForAspectRatio(aspectRatio);

    const model = params.model || this.defaultModel;
    const usage: ImageUsage = this.buildImageUsage(1, `${dimensions.width}x${dimensions.height}`, model);

    return {
      imageData: buffer,
      format,
      dimensions,
      metadata: {
        aspectRatio,
        imageSize: params.imageSize,
        model,
        provider: this.name,
        generatedAt: new Date().toISOString(),
        originalPrompt: params.prompt,
        referenceImagesCount: params.referenceImages?.length || 0,
        openRouterModel: spec.openRouterId,
        mediaType: item.media_type,
        reportedCostUsd: response.usage?.cost,
        imageTokens: response.usage?.completion_tokens_details?.image_tokens
      },
      usage
    };
  }

  private resolveFormat(mediaType: string | undefined, buffer: Buffer): OutputFormat {
    const fromHeader = mediaType ? MEDIA_TYPE_TO_FORMAT[mediaType.toLowerCase()] : undefined;
    if (fromHeader) {
      return fromHeader;
    }

    if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x89504e47) return 'png';
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
    if (buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';

    throw new Error(`Unsupported image format from OpenRouter: ${mediaType || 'unknown media type'}`);
  }

  private dimensionsForAspectRatio(aspectRatio: string): { width: number; height: number } {
    const [width, height] = ASPECT_RATIO_TO_DIMENSIONS[aspectRatio] || [1024, 1024];
    return { width, height };
  }
}
