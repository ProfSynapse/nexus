/**
 * OpenAI Image Generation Adapter
 * Location: src/services/llm/adapters/openai/OpenAIImageAdapter.ts
 *
 * Speaks the Images API with an explicit gpt-image-* model:
 * POST /v1/images/generations for a prompt alone, and the multipart
 * POST /v1/images/edits when reference images are supplied (up to 16, read
 * from the vault). The earlier Responses-API route (a chat model plus the
 * image_generation tool) picked the image model for us and hid its price.
 *
 * GPT Image 2.6 adds `complexity`, SVG and GIF output on generations, and
 * markup-guided edits. Where the docs and the endpoint disagreed, the limits
 * here are what the endpoint enforced when probed on 2026-11-05.
 *
 * Reference: https://developers.openai.com/api/docs/api-reference/images/create
 */

import { TFile, Vault } from 'obsidian';
import { BaseImageAdapter } from '../BaseImageAdapter';
import { ProviderHttpResponse } from '../shared/ProviderHttpClient';
import { buildMultipartFormData, MultipartField } from '../../utils/MultipartFormDataBuilder';
import {
  ImageGenerationParams,
  ImageGenerationResponse,
  ImageValidationResult,
  ImageModel,
  ImageModelFeatures,
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
import { OPENAI_MODELS } from './OpenAIModels';

type OutputFormat = 'png' | 'jpeg' | 'webp' | 'svg' | 'gif';

/**
 * Everything the adapter needs to know about one model. Token prices come from
 * the OpenAI pricing page; `costPerImage` is a measured 1024x1024 image at
 * `medium` quality, since `auto` resolves to a different quality per model.
 */
export interface OpenAIImageModelSpec {
  displayName: string;
  /** USD for one 1024x1024 image at medium quality. */
  costPerImage: number;
  pricingNote: string;
  inputTokenPricePerMillion: number;
  textInputTokenPricePerMillion?: number;
  outputTokenPricePerMillion: number;
  defaultQuality?: 'medium';
  strictSizeLimits?: boolean;
  features?: ImageModelFeatures;
  lastUpdated: string;
}

interface OpenAIImagesRequestBody {
  model: string;
  prompt: string;
  n: 1;
  size?: string;
  output_format: OutputFormat;
  quality?: 'medium';
  complexity?: string;
  frame_count?: number;
  frame_duration_ms?: number;
  svg?: { model: string };
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
    input_tokens_details?: {
      text_tokens?: number;
      image_tokens?: number;
    };
    output_tokens_details?: {
      image_tokens?: number;
      text_tokens?: number;
    };
  };
  /** The model that wrote the SVG, billed apart from the reference image in `usage`. */
  svg_usage?: {
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
  };
}

const FIXED_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];

/** The Images edits endpoint accepts up to 16 input images for GPT image models. */
export const MAX_REFERENCE_IMAGES = 16;

const REFERENCE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
};

interface ReferenceImagePart {
  bytes: ArrayBuffer;
  filename: string;
  mimeType: string;
}

// Pixel dimensions per aspect ratio for models that accept arbitrary sizes.
// gpt-image-2 rejects any dimension not divisible by 16, so every entry is an
// exact ratio built from multiples of 16 near one megapixel. Every GPT image
// model rejects anything past 3:1, so 1:4, 4:1, 1:8 and 8:1 are not offered.
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
  '21:9': '1568x672'
};

/** Every model in this catalog takes the same ratios. GIF frames use the same set. */
export const OPENAI_IMAGE_ASPECT_RATIOS: readonly string[] = Object.keys(ASPECT_RATIO_TO_SIZE);

// GIF frames are packed onto one sprite sheet, so frames near a megapixel do not
// fit: 1024x1024 fails even at 4 frames. These stay within the frame area that
// rendered at 16 frames, the maximum.
const GIF_ASPECT_RATIO_TO_SIZE: Record<string, string> = {
  '1:1': '512x512',
  '2:3': '416x624',
  '3:2': '624x416',
  '3:4': '480x640',
  '4:3': '640x480',
  '4:5': '512x640',
  '5:4': '640x512',
  '9:16': '432x768',
  '16:9': '768x432',
  '21:9': '672x288'
};

/**
 * Writes the SVG from the reference image the image model renders. The endpoint
 * requires a text model here and the docs name none, so this is the cheapest
 * current one. Its tokens are priced from OPENAI_MODELS.
 */
const SVG_AUTHOR_MODEL = 'gpt-6-luna';

/** Reasoning plus authoring on top of the render. A low-quality icon took 45 s. */
const SVG_TIMEOUT_MS = 300_000;

const GPT_IMAGE_26_FEATURES: ImageModelFeatures = { complexity: true, svgAndGif: true, markup: true };

export const OPENAI_IMAGE_MODEL_SPECS: Readonly<Record<string, OpenAIImageModelSpec>> = {
  'gpt-image-2': {
    displayName: 'GPT Image 2',
    costPerImage: 0.053,
    pricingNote: '1756 output tokens at $30/M for 1024x1024 medium; auto picked low (196 tokens) on a simple prompt',
    inputTokenPricePerMillion: 8,
    outputTokenPricePerMillion: 30,
    lastUpdated: '2026-09-02'
  },
  // https://developers.openai.com/api/docs/guides/image-generation
  'gpt-image-2.5-sunburst': {
    displayName: 'GPT Image 2.5 Sunburst',
    costPerImage: 0.01317,
    pricingNote: 'Measured 439 output tokens at $30/M for 1024x1024 medium; input tokens billed separately',
    inputTokenPricePerMillion: 8,
    textInputTokenPricePerMillion: 5,
    outputTokenPricePerMillion: 30,
    defaultQuality: 'medium',
    strictSizeLimits: true,
    lastUpdated: '2026-09-08'
  },
  'gpt-image-2.5-flare': {
    displayName: 'GPT Image 2.5 Flare',
    costPerImage: 0.01317,
    pricingNote: 'Measured 439 output tokens at $30/M for 1024x1024 medium; input tokens billed separately',
    inputTokenPricePerMillion: 8,
    textInputTokenPricePerMillion: 5,
    outputTokenPricePerMillion: 30,
    defaultQuality: 'medium',
    strictSizeLimits: true,
    lastUpdated: '2026-09-08'
  },
  // https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst
  // Same token rates as 2.5, but a 1024x1024 medium image is about 3.3x the tokens.
  'gpt-image-2.6-sunburst': {
    displayName: 'GPT Image 2.6 Sunburst',
    costPerImage: 0.04347,
    pricingNote: 'Measured 1449 output tokens at $30/M for 1024x1024 medium; input tokens billed separately',
    inputTokenPricePerMillion: 8,
    textInputTokenPricePerMillion: 5,
    outputTokenPricePerMillion: 30,
    defaultQuality: 'medium',
    strictSizeLimits: true,
    features: GPT_IMAGE_26_FEATURES,
    lastUpdated: '2026-11-05'
  },
  // https://developers.openai.com/api/docs/models/gpt-image-2.6-flare
  'gpt-image-2.6-flare': {
    displayName: 'GPT Image 2.6 Flare',
    costPerImage: 0.04347,
    pricingNote: 'Measured 1449 output tokens at $30/M for 1024x1024 medium; input tokens billed separately',
    inputTokenPricePerMillion: 8,
    textInputTokenPricePerMillion: 5,
    outputTokenPricePerMillion: 30,
    defaultQuality: 'medium',
    strictSizeLimits: true,
    features: GPT_IMAGE_26_FEATURES,
    lastUpdated: '2026-11-05'
  }
};

export class OpenAIImageAdapter extends BaseImageAdapter {

  // Image adapters don't support streaming in the same way as text
  async* generateStreamAsync(_prompt: string, _options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    await Promise.resolve();
    yield* [] as StreamChunk[];
    throw new Error('Image generation does not support streaming');
  }

  readonly name = 'openai-image';
  readonly baseUrl = 'https://api.openai.com/v1';

  private readonly modelSpecs = OPENAI_IMAGE_MODEL_SPECS;

  readonly supportedModels: ImageModel[] = Object.keys(this.modelSpecs) as ImageModel[];
  readonly supportedSizes: string[] = [...FIXED_SIZES];
  readonly supportedFormats: string[] = ['png', 'jpeg', 'webp', 'svg', 'gif'];

  private readonly defaultModel = 'gpt-image-2';
  private vault: Vault | null = null;

  constructor(config?: ProviderConfig & { vault?: Vault }) {
    const apiKey = config?.apiKey || '';
    super(apiKey, 'gpt-image-2', config?.baseUrl);

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

  protected getImageModelFeatures(model: string): ImageModelFeatures {
    return this.modelSpecs[model]?.features ?? {};
  }

  protected getModelAspectRatios(_model: string): readonly string[] {
    return OPENAI_IMAGE_ASPECT_RATIOS;
  }

  protected getGenerationTimeoutMs(params: ImageGenerationParams): number {
    return params.outputFormat === 'svg' ? SVG_TIMEOUT_MS : super.getGenerationTimeoutMs(params);
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
        output_format: params.outputFormat ?? 'png'
      };

      const size = this.resolveSize(params);
      const sizeError = spec.strictSizeLimits && params.outputFormat !== 'gif' ? this.getSizeError(size) : undefined;
      if (sizeError) throw new Error(sizeError);
      if (size) {
        requestBody.size = size;
      }
      if (spec.defaultQuality) requestBody.quality = spec.defaultQuality;
      if (params.complexity && spec.features?.complexity) requestBody.complexity = params.complexity;
      if (params.outputFormat === 'gif') {
        if (params.frameCount !== undefined) requestBody.frame_count = params.frameCount;
        if (params.frameDurationMs !== undefined) requestBody.frame_duration_ms = params.frameDurationMs;
      }
      if (params.outputFormat === 'svg') requestBody.svg = { model: SVG_AUTHOR_MODEL };

      const hasReferenceImages = !!params.referenceImages && params.referenceImages.length > 0;

      // Retries cover 408/409/429/5xx only; a 4xx rejection is final.
      const result = hasReferenceImages
        ? await this.requestEdit(model, params, size)
        : await this.request<OpenAIImagesResponse>({
          url: `${this.baseUrl}/images/generations`,
          operation: 'image generation',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(requestBody),
          timeoutMs: this.getGenerationTimeoutMs(params),
          retries: 2
        });

      this.assertOk(result, `OpenAI image ${hasReferenceImages ? 'edit' : 'generation'} failed: HTTP ${result.status}`);

      if (!result.json) {
        throw new Error('No response returned from OpenAI image generation');
      }

      return this.buildImageResponse(result.json, params, model, spec);
    } catch (error) {
      this.handleImageError(error, 'image generation', params);
    }
  }

  /**
   * Pick the `size` to send: an explicit size wins; otherwise the exact pixels
   * for the aspect ratio (every catalog model accepts arbitrary WIDTHxHEIGHT).
   */
  private resolveSize(params: ImageGenerationParams): string {
    if (params.size) {
      return params.size;
    }
    if (params.outputFormat === 'gif') {
      return (params.aspectRatio && GIF_ASPECT_RATIO_TO_SIZE[params.aspectRatio]) || 'auto';
    }
    // Always send a size: with `size` omitted OpenAI also picks the quality,
    // which has resolved to a high-quality 1536x1024 at several times the
    // list price.
    if (!params.aspectRatio) {
      return '1024x1024';
    }
    return ASPECT_RATIO_TO_SIZE[params.aspectRatio] || '1024x1024';
  }

  private getSizeError(size: string | undefined): string | undefined {
    if (!size || size === 'auto') return undefined;
    const dimensions = this.parseSize(size);
    if (!dimensions) return 'Use WIDTHxHEIGHT in pixels or "auto"';
    const { width, height } = dimensions;
    const pixels = width * height;
    if (width % 16 || height % 16 || width > 3840 || height > 3840 ||
        pixels < 655360 || pixels > 8294400 || width / height < 1 / 3 || width / height > 3) {
      return 'Image dimensions must be multiples of 16, at most 3840 per edge, 655,360–8,294,400 total pixels, and between 1:3 and 3:1';
    }
    return undefined;
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

    if (params.size && !/^\d{3,4}x\d{3,4}$/.test(params.size) && params.size !== 'auto') {
      errors.push(`Invalid size ${params.size}. Use WIDTHxHEIGHT in pixels or "auto"`);
    }

    if (params.imageSize) {
      warnings.push(`${model} sizes images in pixels; imageSize ${params.imageSize} ignored`);
      adjustedParams.imageSize = undefined;
    }
    if (params.outputFormat !== 'gif' && spec.strictSizeLimits) {
      const sizeError = this.getSizeError(this.resolveSize(params));
      if (sizeError) errors.push(sizeError);
    }

    if (params.referenceImages && params.referenceImages.length > 0) {
      if (params.referenceImages.length > MAX_REFERENCE_IMAGES) {
        errors.push(`Too many reference images. OpenAI image edits accept at most ${MAX_REFERENCE_IMAGES}`);
      }
      if (!this.vault) {
        errors.push('Vault not configured - cannot load reference images');
      }
      for (const path of params.referenceImages) {
        if (!this.getReferenceMimeType(path)) {
          errors.push(`Invalid reference image format: ${path}. Supported formats: .png, .jpg, .jpeg, .webp`);
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

  /**
   * POST /v1/images/edits: the prompt plus every reference image as an
   * `image[]` part, and optionally a `markup` overlay that annotates the first.
   * Same response shape as generations.
   */
  private async requestEdit(
    model: string,
    params: ImageGenerationParams,
    size: string | undefined
  ): Promise<ProviderHttpResponse<OpenAIImagesResponse>> {
    const fields: MultipartField[] = [
      { name: 'model', value: model },
      { name: 'prompt', value: params.prompt },
      { name: 'n', value: '1' },
      { name: 'output_format', value: 'png' }
    ];
    if (size) {
      fields.push({ name: 'size', value: size });
    }
    const spec = this.modelSpecs[model];
    if (spec?.defaultQuality) fields.push({ name: 'quality', value: spec.defaultQuality });
    if (params.complexity && spec?.features?.complexity) fields.push({ name: 'complexity', value: params.complexity });
    for (const part of await this.loadReferenceImages(params.referenceImages ?? [])) {
      fields.push({ name: 'image[]', value: part.bytes, filename: part.filename, contentType: part.mimeType });
    }
    if (params.markupImage) {
      const [part] = await this.loadReferenceImages([params.markupImage]);
      fields.push({ name: 'markup', value: part.bytes, filename: part.filename, contentType: part.mimeType });
    }

    const { body, contentType } = buildMultipartFormData(fields);
    return this.request<OpenAIImagesResponse>({
      url: `${this.baseUrl}/images/edits`,
      operation: 'image edit',
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Authorization': `Bearer ${this.apiKey}`
      },
      body,
      timeoutMs: 180_000,
      retries: 2
    });
  }

  private async loadReferenceImages(paths: string[]): Promise<ReferenceImagePart[]> {
    if (!this.vault) {
      throw new Error('Vault not configured - cannot load reference images');
    }

    const parts: ReferenceImagePart[] = [];
    for (const path of paths) {
      const file = this.vault.getAbstractFileByPath(path);
      if (!file) {
        throw new Error(`Reference image not found: ${path}`);
      }
      if (!(file instanceof TFile)) {
        throw new Error(`Reference path is not a file: ${path}`);
      }
      const mimeType = this.getReferenceMimeType(path);
      if (!mimeType) {
        throw new Error(`Invalid reference image format: ${path}`);
      }
      parts.push({
        bytes: await this.vault.readBinary(file),
        filename: file.name,
        mimeType
      });
    }
    return parts;
  }

  private getReferenceMimeType(path: string): string | undefined {
    const ext = path.toLowerCase().split('.').pop() || '';
    return REFERENCE_MIME_TYPES[ext];
  }

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
    const textTokens = response.usage?.input_tokens_details?.text_tokens ??
      (params.referenceImages?.length ? 0 : inputTokens);
    const inputCost = spec.textInputTokenPricePerMillion === undefined
      ? inputTokens * spec.inputTokenPricePerMillion
      : textTokens * spec.textInputTokenPricePerMillion + (inputTokens - textTokens) * spec.inputTokenPricePerMillion;
    const reportedCostUsd = (inputCost + outputTokens * spec.outputTokenPricePerMillion) / 1_000_000 +
      this.svgAuthorCostUsd(response.svg_usage);

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

  /** The authoring model's share of an SVG, at its own token rates. */
  private svgAuthorCostUsd(usage: OpenAIImagesResponse['svg_usage']): number {
    const author = usage && OPENAI_MODELS.find(candidate => candidate.apiName === usage.model);
    if (!usage || !author) return 0;
    return ((usage.input_tokens ?? 0) * author.inputCostPerMillion +
      (usage.output_tokens ?? 0) * author.outputCostPerMillion) / 1_000_000;
  }

  private resolveFormat(outputFormat: string | undefined, buffer: Buffer): OutputFormat {
    if (outputFormat === 'png' || outputFormat === 'jpeg' || outputFormat === 'webp' ||
        outputFormat === 'svg' || outputFormat === 'gif') {
      return outputFormat;
    }
    return sniffImageFormat(buffer) || 'png';
  }

  private parseSize(size: string | undefined): { width: number; height: number } | null {
    const match = size?.match(/^(\d+)x(\d+)$/);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  }
}
