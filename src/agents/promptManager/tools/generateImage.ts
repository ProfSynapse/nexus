import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
/**
 * Generate Image Tool - Image generation workflow for AgentManager
 * Integrates with ImageGenerationService and follows AgentManager patterns
 */

import { BaseTool } from '../../baseTool';
import { ToolStatusTense } from '../../interfaces/ITool';
import { verbs, labelNamed } from '../../utils/toolStatusLabels';
import { CommonResult, CommonParameters } from '../../../types';
import { createResult } from '../../../utils/schemaUtils';
import { ImageGenerationService } from '../../../services/llm/ImageGenerationService';
import { 
  AspectRatio,
  ImageComplexity,
  ImageVectorOrAnimationFormat
} from '../../../services/llm/types/ImageTypes';
import { SchemaBuilder } from '../../../utils/schemas/SchemaBuilder';
import { Vault } from 'obsidian';
import { LLMProviderSettings } from '../../../types/llm/ProviderTypes';
import {
  describeRetiredModelSubstitution,
  getRetiredImageModel,
  type RetiredModel
} from '../../../services/llm/types/RetiredMediaModels';
import { ALL_ASPECT_RATIOS, DEFAULT_IMAGE_MODEL, ImageProvider, NanoBananaImageSize } from '../../../services/llm/types/ImageTypes';
import {
  getConfiguredImageProviders,
  ImageModelCapability,
  listImageModelCapabilities
} from '../../../services/llm/imageModelCapabilities';
import { describeModelsByProvider, groupModels, joinWithOr } from '../../../services/llm/mediaModelText';

const PROVIDER_PHRASES: Record<ImageProvider, string> = {
  google: 'Google Nano Banana',
  openai: 'OpenAI GPT Image',
  openrouter: 'any OpenRouter image model'
};

const IMAGE_SIZE_ORDER: NanoBananaImageSize[] = ['512px', '1K', '2K', '4K'];

/**
 * Parameters that only some models take. Each appears only when a provider with
 * a key has a model that accepts it, and names those models, so nothing here goes
 * stale when a catalog changes. executePrompts shares this for its image requests.
 */
export function buildImageCapabilityProperties(models: ImageModelCapability[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  if (models.length > 0) {
    properties.aspectRatio = {
      type: 'string',
      enum: ALL_ASPECT_RATIOS.filter(ratio => models.some(model => model.aspectRatios.includes(ratio))),
      description: `Aspect ratio for the generated image. Supported per model: ${groupModels(models, model => model.aspectRatios.join(', '))}`
    };
  }

  const sized = models.filter(model => model.imageSizes.length > 0);
  if (sized.length > 0) {
    properties.imageSize = {
      type: 'string',
      enum: IMAGE_SIZE_ORDER.filter(size => sized.some(model => model.imageSizes.includes(size))),
      description: `Image resolution. Models not listed do not take one. ${groupModels(sized, model => model.imageSizes.join(', '))}`
    };
  }

  const withReferences = models.filter(model => model.maxReferenceImages > 0);
  if (withReferences.length > 0) {
    properties.referenceImages = {
      type: 'array',
      items: { type: 'string' },
      maxItems: Math.max(...withReferences.map(model => model.maxReferenceImages)),
      description: `Reference images for style/composition. Most per model: ${groupModels(withReferences, model => String(model.maxReferenceImages))}`
    };
  }

  const withComplexity = models.filter(model => model.features.complexity);
  if (withComplexity.length > 0) {
    properties.complexity = {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: `How much the model plans before rendering. Omitted means high. Lower is faster and suits focused edits; higher helps dense text and complex layouts but can introduce unwanted changes. Same price at every level. Only on ${describeModelsByProvider(withComplexity)}`
    };
  }

  const withSvgAndGif = models.filter(model => model.features.svgAndGif);
  if (withSvgAndGif.length > 0) {
    properties.outputFormat = {
      type: 'string',
      enum: ['svg', 'gif'],
      description: `Make an editable SVG or an animated GIF instead of a raster image. Cannot use referenceImages. SVG is slow (up to a few minutes). For GIF, describe the motion and loop in the prompt. Omit for a raster image. Set provider and model to one of ${describeModelsByProvider(withSvgAndGif)}`
    };
    properties.frameCount = {
      type: 'number',
      minimum: 2,
      maximum: 16,
      description: 'Frames in the animation (default 9). Only with outputFormat gif.'
    };
    properties.frameDurationMs = {
      type: 'number',
      minimum: 20,
      description: 'Milliseconds per frame, rounded to 10 (default 200). Only with outputFormat gif.'
    };
  }

  const withMarkup = models.filter(model => model.features.markup);
  if (withMarkup.length > 0) {
    properties.markupImage = {
      type: 'string',
      description: `Vault path of a transparent PNG with circles or sketches showing where to edit the first reference image. Must match that image's width and height. Requires referenceImages. Say in the prompt to remove the marks from the result. Set provider and model to one of ${describeModelsByProvider(withMarkup)}`
    };
  }

  return properties;
}

/** The savePath pattern for these models: SVG and GIF only when one can make them. */
export function buildImageSavePathPattern(models: ImageModelCapability[]): string {
  const extensions = ['png', 'jpg', 'jpeg', 'webp', ...(models.some(model => model.features.svgAndGif) ? ['svg', 'gif'] : [])];
  return `^[^/].*\\.(${extensions.join('|')})$`;
}

/**
 * The one-line description an agent sees before it asks for the full schema,
 * so it has to mention an output type or an agent asked for one will not look.
 * Written only from the providers that have a key.
 */
export function buildGenerateImageDescription(providers: readonly ImageProvider[]): string {
  const models = listImageModelCapabilities(providers);
  const sentences = [
    `Generate images with ${joinWithOr(providers.map(provider => PROVIDER_PHRASES[provider])) || 'a configured image provider'}.`,
    'Supports reference images for style/composition guidance.'
  ];
  const svgAndGif = models.filter(model => model.features.svgAndGif);
  if (svgAndGif.length > 0) {
    sentences.push(`Can also make SVG and animated GIF files (${describeModelsByProvider(svgAndGif)}).`);
  }
  const markup = models.filter(model => model.features.markup);
  if (markup.length > 0) {
    sentences.push(`Can edit from an annotated overlay (${describeModelsByProvider(markup)}).`);
  }
  return sentences.join(' ');
}

export interface GenerateImageParams extends CommonParameters {
  prompt: string;
  provider?: 'google' | 'openrouter' | 'openai'; // Defaults to user settings or first available provider
  model?: string; // Defaults to user settings or first available model for the provider
  aspectRatio?: AspectRatio;
  numberOfImages?: number;
  imageSize?: '512px' | '1K' | '2K' | '4K';
  referenceImages?: string[]; // Vault-relative paths to reference images
  complexity?: ImageComplexity;
  outputFormat?: ImageVectorOrAnimationFormat;
  frameCount?: number;
  frameDurationMs?: number;
  markupImage?: string; // Vault-relative transparent PNG annotating the first reference image
  savePath: string;
}

export interface GenerateImageModeResult extends CommonResult {
  data?: {
    imagePath: string;
    /** Present when the requested model was retired and its successor was used. */
    note?: string;
  };
}

/**
 * Image Generation Tool for AgentManager
 * Handles AI image generation requests through Google provider
 */
export class GenerateImageTool extends BaseTool<GenerateImageParams, GenerateImageModeResult> {
  private imageService: ImageGenerationService | null = null;
  private schemaBuilder: SchemaBuilder;
  private vault: Vault | null = null;
  private llmSettings: LLMProviderSettings | null = null;

  constructor(dependencies?: { vault?: Vault; llmSettings?: LLMProviderSettings }) {
    super(
      'generateImage',
      'Generate Image',
      buildGenerateImageDescription(getConfiguredImageProviders(dependencies?.llmSettings)),
      '2.1.0'
    );

    this.schemaBuilder = new SchemaBuilder(null);

    // Use injected dependencies if provided
    if (dependencies) {
      if (dependencies.vault) {
        this.vault = dependencies.vault;
      }
      if (dependencies.llmSettings) {
        this.llmSettings = dependencies.llmSettings;
      }

      // Initialize service if both dependencies are available
      if (this.vault && this.llmSettings) {
        this.initializeImageService();
      }
    }
  }

  /**
   * Set the vault instance for image generation service
   */
  setVault(vault: Vault): void {
    this.vault = vault;
    this.initializeImageService();
  }

  /**
   * Set LLM provider settings
   */
  setLLMSettings(llmSettings: LLMProviderSettings): void {
    this.llmSettings = llmSettings;
    this.description = buildGenerateImageDescription(getConfiguredImageProviders(llmSettings));
    this.initializeImageService();
  }

  /**
   * Initialize image service when both vault and settings are available
   */
  private initializeImageService(): void {
    if (this.vault && this.llmSettings) {
      this.imageService = new ImageGenerationService(this.vault, this.llmSettings);
    }
  }

  /**
   * Execute image generation
   */
  async execute(params: GenerateImageParams): Promise<GenerateImageModeResult> {
    try {
      // Validate service availability
      if (!this.imageService) {
        return createResult<GenerateImageModeResult>(
          false,
          undefined,
          'Image generation service not initialized. Vault instance required.'
        );
      }

      // Check if any providers are available
      if (!this.imageService.hasAvailableProviders()) {
        return createResult<GenerateImageModeResult>(
          false,
          undefined,
          'No image generation providers available. Please configure a Google, OpenAI or OpenRouter API key in plugin settings.'
        );
      }

      // Apply defaults from user settings, falling back to first available provider/model
      const { provider, model, retiredModel } = this.resolveDefaults(params.provider, params.model);

      // Validate parameters
      const validation = this.imageService.validateParams({
        prompt: params.prompt,
        provider,
        model,
        aspectRatio: params.aspectRatio,
        numberOfImages: params.numberOfImages,
        imageSize: params.imageSize,
        referenceImages: params.referenceImages,
        complexity: params.complexity,
        outputFormat: params.outputFormat,
        frameCount: params.frameCount,
        frameDurationMs: params.frameDurationMs,
        markupImage: params.markupImage,
        savePath: params.savePath,
        sessionId: 'default',
        context: ''
      });

      if (!validation.isValid) {
        const availableModels = this.getAvailableModelIds();
        const availableProviders = this.getAvailableProviderNames();
        return createResult<GenerateImageModeResult>(
          false,
          undefined,
          `Parameter validation failed: ${[...validation.errors, ...this.describeUnavailableFeatures(params)].join(', ')}. Available providers: ${availableProviders.join(', ')}. Available models: ${availableModels.join(', ')}`
        );
      }

      // Generate the image
      const result = await this.imageService.generateImage({
        prompt: params.prompt,
        provider,
        model,
        aspectRatio: params.aspectRatio,
        numberOfImages: params.numberOfImages,
        imageSize: params.imageSize,
        referenceImages: params.referenceImages,
        complexity: params.complexity,
        outputFormat: params.outputFormat,
        frameCount: params.frameCount,
        frameDurationMs: params.frameDurationMs,
        markupImage: params.markupImage,
        savePath: params.savePath,
        sessionId: 'default',
        context: ''
      });

      if (!result.success) {
        return createResult<GenerateImageModeResult>(
          false,
          undefined,
          result.error || 'Image generation failed'
        );
      }

      // Return lean result - just the path, plus a note when a retired model
      // id was swapped for its successor or a parameter had no effect
      const notes = [
        ...(retiredModel ? [describeRetiredModelSubstitution(retiredModel)] : []),
        ...(validation.warnings ?? [])
      ];
      return createResult<GenerateImageModeResult>(
        true,
        result.data
          ? {
            imagePath: result.data.imagePath,
            ...(notes.length > 0 ? { note: notes.join(' ') } : {})
          }
          : undefined
      );

    } catch (error) {
      return createResult<GenerateImageModeResult>(
        false,
        undefined,
        `Image generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /** Models that can serve a request right now, from the providers with a key. */
  private getAvailableCapabilities(): ImageModelCapability[] {
    return listImageModelCapabilities(this.imageService?.getInitializedProviders() ?? []);
  }

  /**
   * A caller can name a parameter this setup hides: a saved prompt, or a schema
   * read before a key was removed. Say where it does work, or that nothing here
   * offers it, so the agent stops retrying and can tell the user.
   */
  private describeUnavailableFeatures(params: GenerateImageParams): string[] {
    const models = this.getAvailableCapabilities();
    const describe = (label: string, supported: ImageModelCapability[]) => supported.length > 0
      ? `${label} is available on ${describeModelsByProvider(supported)}`
      : `${label} is not available with the configured providers`;
    return [
      ...(params.outputFormat ? [describe(`${params.outputFormat} output`, models.filter(model => model.features.svgAndGif))] : []),
      ...(params.markupImage ? [describe('markupImage', models.filter(model => model.features.markup))] : [])
    ];
  }

  /**
   * Resolve provider and model defaults from user settings.
   * Priority: explicit param > user settings > first available provider/model
   */
  private resolveDefaults(
    paramProvider?: string,
    paramModel?: string
  ): { provider: 'google' | 'openrouter' | 'openai'; model: string; retiredModel?: RetiredModel } {
    // User settings defaults
    const settingsProvider = this.llmSettings?.defaultImageModel?.provider;
    const settingsModel = this.llmSettings?.defaultImageModel?.model;

    // Resolve provider: param > settings > first available > 'google'
    let provider: 'google' | 'openrouter' | 'openai' = (paramProvider as 'google' | 'openrouter' | 'openai') || settingsProvider || 'google';

    // If chosen provider is not available, try the other one
    if (this.imageService) {
      const initializedProviders = this.imageService.getInitializedProviders();
      if (initializedProviders.length > 0 && !initializedProviders.includes(provider)) {
        const available = initializedProviders.find(p => p === 'google' || p === 'openrouter' || p === 'openai');
        if (available) {
          provider = available;
        }
      }
    }

    // Resolve model: param > settings (if matching provider) > first model for provider
    let model = paramModel || '';
    if (!model && settingsModel && settingsProvider === provider) {
      model = settingsModel;
    }
    if (!model && this.imageService) {
      const providerModels = this.imageService.getSupportedModelIds(provider);
      if (providerModels.length > 0) {
        model = providerModels[0];
      }
    }
    if (!model) {
      model = DEFAULT_IMAGE_MODEL;
    }

    // A saved prompt, conversation or agent may still name a retired id; run
    // the provider's documented successor instead of failing validation.
    const retiredModel = getRetiredImageModel(provider, model);
    if (retiredModel) {
      return { provider, model: retiredModel.replacement, retiredModel };
    }

    return { provider, model };
  }

  /**
   * Build the dynamic model enum from the image service adapters.
   * Falls back to a static list if the service isn't initialized.
   */
  private getAvailableModelIds(): string[] {
    if (this.imageService) {
      // Collect unique model IDs across all initialized adapters
      const modelIds = new Set<string>();
      const providers: Array<'google' | 'openrouter' | 'openai'> = ['google', 'openrouter', 'openai'];
      for (const provider of providers) {
        const models = this.imageService.getSupportedModelIds(provider);
        for (const id of models) {
          modelIds.add(id);
        }
      }
      if (modelIds.size > 0) {
        return Array.from(modelIds);
      }
    }

    // Minimal fallback — only the most common default model
    return [DEFAULT_IMAGE_MODEL];
  }

  /**
   * Get list of available provider names for schema and error messages
   */
  private getAvailableProviderNames(): string[] {
    if (this.imageService) {
      const providers = this.imageService.getInitializedProviders()
        .filter(p => p === 'google' || p === 'openrouter' || p === 'openai');
      if (providers.length > 0) {
        return providers;
      }
    }
    return ['google', 'openrouter', 'openai'];
  }

  /**
   * Get parameter schema for MCP
   */
  getParameterSchema(): JSONSchema {
    const modelEnum = this.getAvailableModelIds();
    const providerEnum = this.getAvailableProviderNames();
    const defaults = this.resolveDefaults();

    const models = this.getAvailableCapabilities();

    const properties: Record<string, unknown> = {
      prompt: {
        type: 'string',
        description: 'Text prompt describing the image to generate',
        minLength: 1,
        maxLength: 32000
      },
      provider: {
        type: 'string',
        enum: providerEnum,
        default: defaults.provider,
        description: `AI provider (default: ${defaults.provider}). Available: ${providerEnum.join(', ')}`
      },
      model: {
        type: 'string',
        enum: modelEnum,
        default: defaults.model,
        description: `Image generation model (default: ${defaults.model}). Available: ${describeModelsByProvider(models) || modelEnum.join(', ')}`
      },
      ...buildImageCapabilityProperties(models),
      savePath: {
        type: 'string',
        description: 'Vault-relative path for the image. Extension may change based on API response format.',
        pattern: buildImageSavePathPattern(models)
      }
    };

    const toolSchema = {
      type: 'object',
      properties,
      required: ['prompt', 'savePath']
    };

    return this.getMergedSchema(toolSchema);
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const v = verbs('Generating image', 'Generated image', 'Failed to generate image');
    return labelNamed(v, params, tense, ['prompt']);
  }

  /**
   * Get result schema for MCP (lean format)
   */
  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: {
          type: 'object',
          properties: {
            imagePath: { type: 'string', description: 'Path where image was saved' },
            note: { type: 'string', description: 'Set when the requested model was retired and its successor was used, or a parameter had no effect on this model' }
          }
        },
        error: { type: 'string' }
      },
      required: ['success']
    };
  }
}
