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
  AspectRatio
} from '../../../services/llm/types/ImageTypes';
import { SchemaBuilder } from '../../../utils/schemas/SchemaBuilder';
import { Vault } from 'obsidian';
import { LLMProviderSettings } from '../../../types/llm/ProviderTypes';

export interface GenerateImageParams extends CommonParameters {
  prompt: string;
  provider?: 'google' | 'openrouter' | 'openai'; // Defaults to user settings or first available provider
  model?: string; // Defaults to user settings or first available model for the provider
  aspectRatio?: AspectRatio;
  numberOfImages?: number;
  imageSize?: '512px' | '1K' | '2K' | '4K';
  referenceImages?: string[]; // Vault-relative paths to reference images
  savePath: string;
}

export interface GenerateImageModeResult extends CommonResult {
  data?: {
    imagePath: string;
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
      'Generate images with Google Nano Banana, OpenAI GPT Image, or any OpenRouter image model. Supports reference images for style/composition guidance.',
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
      const { provider, model } = this.resolveDefaults(params.provider, params.model);

      // Validate parameters
      const validation = this.imageService.validateParams({
        prompt: params.prompt,
        provider,
        model,
        aspectRatio: params.aspectRatio,
        numberOfImages: params.numberOfImages,
        imageSize: params.imageSize,
        referenceImages: params.referenceImages,
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
          `Parameter validation failed: ${validation.errors.join(', ')}. Available providers: ${availableProviders.join(', ')}. Available models: ${availableModels.join(', ')}`
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

      // Return lean result - just the path
      return createResult<GenerateImageModeResult>(
        true,
        result.data ? { imagePath: result.data.imagePath } : undefined
      );

    } catch (error) {
      return createResult<GenerateImageModeResult>(
        false,
        undefined,
        `Image generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Resolve provider and model defaults from user settings.
   * Priority: explicit param > user settings > first available provider/model
   */
  private resolveDefaults(
    paramProvider?: string,
    paramModel?: string
  ): { provider: 'google' | 'openrouter' | 'openai'; model: string } {
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
      model = 'gemini-3.1-flash-image';
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
    return ['gemini-3.1-flash-image'];
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

    const toolSchema = {
      type: 'object',
      properties: {
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
          description: `Image generation model (default: ${defaults.model}). Available: ${modelEnum.join(', ')}`
        },
        aspectRatio: {
          type: 'string',
          enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'],
          description: 'Aspect ratio for the generated image'
        },
        numberOfImages: {
          type: 'number',
          minimum: 1,
          maximum: 4,
          description: 'Number of images to generate (1-4)'
        },
        imageSize: {
          type: 'string',
          enum: ['512px', '1K', '2K', '4K'],
          description: 'Image resolution. gemini-3.1-flash-lite-image is 1K only; 512px is available on gemini-3.1-flash-image; 4K on gemini-3.1-flash-image and gemini-3-pro-image. Not accepted by gemini-2.5-flash-image or the FLUX models.'
        },
        referenceImages: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 14,
          description: 'Reference images for style/composition. Max 3 for gemini-2.5-flash-image, 14 for the Gemini 3.x models; per-model limits apply on OpenRouter; up to 16 on OpenAI'
        },
        savePath: {
          type: 'string',
          description: 'Vault-relative path for the image. Extension may change based on API response format.',
          pattern: '^[^/].*\\.(png|jpg|jpeg|webp)$'
        }
      },
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
            imagePath: { type: 'string', description: 'Path where image was saved' }
          }
        },
        error: { type: 'string' }
      },
      required: ['success']
    };
  }
}
