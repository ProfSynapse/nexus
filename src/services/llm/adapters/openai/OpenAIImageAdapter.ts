/**
 * OpenAI Image Generation Adapter
 * Location: src/services/llm/adapters/openai/OpenAIImageAdapter.ts
 *
 * Speaks the Images API (POST /v1/images/generations) with an explicit
 * gpt-image-* model. The earlier Responses-API route (a chat model plus the
 * image_generation tool) picked the image model for us and hid its price.
 *
 * Reference: https://developers.openai.com/api/docs/api-reference/images/create
 */

import { BaseImageAdapter } from '../BaseImageAdapter';
import {
  ImageGenerationParams,
  ImageGenerationResponse,
  ImageValidationResult,
  ImageModel,
  ImageUsage,
  AspectRatio
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

/**
 * Everything the adapter needs to know about one model. Token prices come from
 * the OpenAI pricing page; `costPerImage` is a measured 1024x1024 image at
 * `medium` quality, since `auto` resolves to a different quality per model.
 */
interface OpenAIImageModelSpec {
  displayName: string;
  /** USD for one 1024x1024 image at medium quality. */
  costPerImage: number;
  pricingNote: string;
  inputTokenPricePerMillion: number;
  outputTokenPricePerMillion: number;
  /** gpt-image-2 accepts any WIDTHxHEIGHT; the others accept three sizes plus auto. */
  supportsArbitrarySize: boolean;
  lastUpdated: string;
}

interface OpenAIImagesRequestBody {
  model: string;
  prompt: string;
  n: 1;
  size?: string;
  output_format: OutputFormat;
}

interface OpenAIImagesResponse {
  created?: number;
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
  size?: string;
  quality?: string;
  output_format?: string;
  background?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    output_tokens_details?: {
      image_tokens?: number;
      text_tokens?: number;
    };
  };
}

const FIXED_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];

// Pixel dimensions per aspect ratio for models that accept arbitrary sizes.
// gpt-image-2 rejects any dimension not divisible by 16, so every entry is an
// exact ratio built from multiples of 16 near one megapixel.
const ASPECT_RATIO_TO_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '2:3': '832x1248',
  '3:2': '1248x832',
  '3:4': '864x1152',
  '4:3': '1152x864',
  '4:5': '896x1120',
  '5:4': '1120x896',
  '9:16': '1008x1792',
  '16:9': '1792x1008',
  '21:9': '1568x672',
  '1:4': '512x2048',
  '4:1': '2048x512',
  '1:8': '256x2048',
  '8:1': '2048x256'
};

const PORTRAIT_RATIOS = new Set(['2:3', '3:4', '4:5', '9:16', '1:4', '1:8']);
const LANDSCAPE_RATIOS = new Set(['3:2', '4:3', '5:4', '16:9', '21:9', '4:1', '8:1']);

export class OpenAIImageAdapter extends BaseImageAdapter {

  // Image adapters don't support streaming in the same way as text
  async* generateStreamAsync(_prompt: string, _options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    await Promise.resolve();
    yield* [] as StreamChunk[];
    throw new Error('Image generation does not support streaming');
  }

  readonly name = 'openai-image';
  readonly baseUrl = 'https://api.openai.com/v1';

  private readonly modelSpecs: Record<string, OpenAIImageModelSpec> = {
    'gpt-image-2': {
      displayName: 'GPT Image 2',
      costPerImage: 0.053,
      pricingNote: '1756 output tokens at $30/M for 1024x1024 medium; auto picked low (196 tokens) on a simple prompt',
      inputTokenPricePerMillion: 8,
      outputTokenPricePerMillion: 30,
      supportsArbitrarySize: true,
      lastUpdated: '2026-09-02'
    },
    'gpt-image-1.5': {
      displayName: 'GPT Image 1.5',
      costPerImage: 0.034,
      pricingNote: '1056 output tokens at $32/M for 1024x1024 medium; auto picks high (4160 tokens, $0.133)',
      inputTokenPricePerMillion: 8,
      outputTokenPricePerMillion: 32,
      supportsArbitrarySize: false,
      lastUpdated: '2026-09-02'
    },
    'gpt-image-1': {
      displayName: 'GPT Image 1',
      costPerImage: 0.042,
      pricingNote: '1056 output tokens at $40/M for 1024x1024 medium',
      inputTokenPricePerMillion: 10,
      outputTokenPricePerMillion: 40,
      supportsArbitrarySize: false,
      lastUpdated: '2026-09-02'
    },
    'gpt-image-1-mini': {
      displayName: 'GPT Image 1 Mini',
      costPerImage: 0.008,
      pricingNote: '1056 output tokens at $8/M for 1024x1024 medium',
      inputTokenPricePerMillion: 2.5,
      outputTokenPricePerMillion: 8,
      supportsArbitrarySize: false,
      lastUpdated: '2026-09-02'
    }
  };

  readonly supportedModels: ImageModel[] = Object.keys(this.modelSpecs) as ImageModel[];
  readonly supportedSizes: string[] = [...FIXED_SIZES];
  readonly supportedFormats: string[] = ['png', 'jpeg', 'webp'];

  private readonly defaultModel = 'gpt-image-2';

  constructor(config?: ProviderConfig) {
    const apiKey = config?.apiKey || '';
    super(apiKey, 'gpt-image-2', config?.baseUrl);

    this.initializeCache();
  }

  /**
   * Generate one image through POST /v1/images/generations.
   */
  async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResponse> {
    try {
      this.validateConfiguration();

      const model = params.model || this.defaultModel;
      const spec = this.modelSpecs[model];
      if (!spec) {
        throw new Error(`Unknown OpenAI image model: ${model}. Supported models: ${this.supportedModels.join(', ')}`);
      }

      const requestBody: OpenAIImagesRequestBody = {
        model,
        prompt: params.prompt,
        n: 1,
        output_format: 'png'
      };

      const size = this.resolveSize(params, spec);
      if (size) {
        requestBody.size = size;
      }

      // Retries cover 408/409/429/5xx only; a 4xx rejection is final.
      const result = await this.request<OpenAIImagesResponse>({
        url: `${this.baseUrl}/images/generations`,
        operation: 'image generation',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(requestBody),
        timeoutMs: 120_000,
        retries: 2
      });

      this.assertOk(result, `OpenAI image generation failed: HTTP ${result.status}`);

      if (!result.json) {
        throw new Error('No response returned from OpenAI image generation');
      }

      return this.buildImageResponse(result.json, params, model, spec);
    } catch (error) {
      this.handleImageError(error, 'image generation', params);
    }
  }

  /**
   * Pick the `size` to send: an explicit size wins; otherwise derive from the
   * aspect ratio — exact pixels for models that accept arbitrary sizes, the
   * nearest fixed size for the rest. Undefined lets the API choose (auto).
   */
  private resolveSize(params: ImageGenerationParams, spec: OpenAIImageModelSpec): string | undefined {
    if (params.size) {
      return params.size;
    }
    // Always send a size: with `size` omitted OpenAI also picks the quality, and
    // for gpt-image-1-mini that resolved to 1536x1024 at high, five times the
    // list price.
    if (!params.aspectRatio) {
      return '1024x1024';
    }
    if (spec.supportsArbitrarySize) {
      return ASPECT_RATIO_TO_SIZE[params.aspectRatio] || '1024x1024';
    }
    if (PORTRAIT_RATIOS.has(params.aspectRatio)) return '1024x1536';
    if (LANDSCAPE_RATIOS.has(params.aspectRatio)) return '1536x1024';
    return '1024x1024';
  }

  /**
   * Validate OpenAI-specific image generation parameters
   */
  validateImageParams(params: ImageGenerationParams): ImageValidationResult {
    // Size is validated per model below: the base check only knows the fixed
    // list, and gpt-image-2 accepts arbitrary WxH.
    const baseValidation = this.validateCommonParams({ ...params, size: undefined });
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

    if (params.prompt.length > 32000) {
      errors.push('Prompt too long (max 32,000 characters)');
    }

    if (params.size) {
      if (spec.supportsArbitrarySize) {
        if (!/^\d{3,4}x\d{3,4}$/.test(params.size) && params.size !== 'auto') {
          errors.push(`Invalid size ${params.size}. Use WIDTHxHEIGHT in pixels or "auto"`);
        }
      } else if (!FIXED_SIZES.includes(params.size)) {
        errors.push(`Invalid size for ${model}. Supported sizes: ${FIXED_SIZES.join(', ')}`);
      }
    }

    if (params.imageSize) {
      warnings.push(`${model} sizes images in pixels; imageSize ${params.imageSize} ignored`);
      adjustedParams.imageSize = undefined;
    }

    if (params.numberOfImages && params.numberOfImages > 1) {
      warnings.push('OpenAI image generation produces one image per request; numberOfImages ignored');
    }

    // Reference images go through /v1/images/edits (multipart), which this
    // adapter does not implement.
    if (params.referenceImages && params.referenceImages.length > 0) {
      errors.push('Reference images are not supported for OpenAI image generation');
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
        'size_variants',
        'aspect_ratio_control',
        'multiple_model_choice'
      ]
    };
  }

  /**
   * Get supported image sizes
   */
  getSupportedImageSizes(): string[] {
    return [...this.supportedSizes];
  }

  /**
   * List price for one 1024x1024 image at medium quality. The actual charge is
   * computed from the response's token usage and recorded as
   * `metadata.reportedCostUsd`.
   */
  getImageModelPricing(model = 'gpt-image-2'): Promise<CostDetails> {
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
   * List available OpenAI image models
   */
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(
      Object.entries(this.modelSpecs).map(([id, spec]) => ({
        id,
        name: spec.displayName,
        contextWindow: 32000,
        maxOutputTokens: 0,
        supportsJSON: false,
        supportsImages: false,
        supportsFunctions: false,
        supportsStreaming: false,
        supportsThinking: false,
        supportsImageGeneration: true,
        pricing: {
          inputPerMillion: spec.inputTokenPricePerMillion,
          outputPerMillion: spec.outputTokenPricePerMillion,
          imageGeneration: spec.costPerImage,
          currency: 'USD',
          lastUpdated: spec.lastUpdated
        }
      }))
    );
  }

  // Private helper methods

  private buildImageResponse(
    response: OpenAIImagesResponse,
    params: ImageGenerationParams,
    model: string,
    spec: OpenAIImageModelSpec
  ): ImageGenerationResponse {
    const item = response.data?.[0];
    if (!item?.b64_json) {
      throw new Error('No image data in OpenAI response');
    }

    const buffer = Buffer.from(item.b64_json, 'base64');
    const format = this.resolveFormat(response.output_format, buffer);
    const dimensions = readImageDimensions(buffer) || this.parseSize(response.size) || { width: 1024, height: 1024 };

    const usage: ImageUsage = this.buildImageUsage(1, `${dimensions.width}x${dimensions.height}`, model);

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const reportedCostUsd = (inputTokens * spec.inputTokenPricePerMillion + outputTokens * spec.outputTokenPricePerMillion) / 1_000_000;

    return {
      imageData: buffer,
      format,
      dimensions,
      metadata: {
        aspectRatio: params.aspectRatio || AspectRatio.SQUARE,
        size: response.size,
        quality: response.quality,
        model,
        provider: this.name,
        generatedAt: new Date().toISOString(),
        originalPrompt: params.prompt,
        reportedCostUsd,
        imageTokens: response.usage?.output_tokens_details?.image_tokens
      },
      usage,
      revisedPrompt: item.revised_prompt
    };
  }

  private resolveFormat(outputFormat: string | undefined, buffer: Buffer): OutputFormat {
    if (outputFormat === 'png' || outputFormat === 'jpeg' || outputFormat === 'webp') {
      return outputFormat;
    }
    return sniffImageFormat(buffer) || 'png';
  }

  private parseSize(size: string | undefined): { width: number; height: number } | null {
    const match = size?.match(/^(\d+)x(\d+)$/);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  }
}
