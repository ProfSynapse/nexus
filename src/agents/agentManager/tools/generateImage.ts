/**
 * Generate Image Tool - Image generation workflow for AgentManager
 * Integrates with ImageGenerationService and follows AgentManager patterns
 */

import { BaseTool } from '../../baseTool';
import { CommonResult, CommonParameters } from '../../../types';
import { createResult } from '../../../utils/schemaUtils';
import { ImageGenerationService } from '../../../services/llm/ImageGenerationService';
import { 
  ImageGenerationParams,
  ImageGenerationResult,
  AspectRatio
} from '../../../services/llm/types/ImageTypes';
import { SchemaBuilder, SchemaType } from '../../../utils/schemas/SchemaBuilder';
import { Vault } from 'obsidian';
import { LLMProviderSettings } from '../../../types/llm/ProviderTypes';

export interface GenerateImageParams extends CommonParameters {
  prompt: string;
  provider?: 'google' | 'openrouter'; // Defaults to 'google' if available
  model?: 'gemini-2.5-flash-image' | 'gemini-3-pro-image-preview' | 'flux-2-pro' | 'flux-2-flex'; // Defaults to 'gemini-2.5-flash-image'
  aspectRatio?: AspectRatio;
  numberOfImages?: number;
  imageSize?: '1K' | '2K' | '4K';
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
      'Generate images using Google Nano Banana models (direct or via OpenRouter). Supports reference images for style/composition guidance.',
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
          'No image generation providers available. Please configure Google API key in plugin settings.'
        );
      }

      // Apply defaults: google provider and gemini-2.5-flash-image model
      const provider = params.provider || 'google';
      const model = params.model || 'gemini-2.5-flash-image';

      // Validate parameters
      const validation = await this.imageService.validateParams({
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
        return createResult<GenerateImageModeResult>(
          false,
          undefined,
          `Parameter validation failed: ${validation.errors.join(', ')}`
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
   * Get parameter schema for MCP
   */
  getParameterSchema(): any {
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
          enum: ['google', 'openrouter'],
          default: 'google',
          description: 'AI provider (default: google)'
        },
        model: {
          type: 'string',
          enum: ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'flux-2-pro', 'flux-2-flex'],
          default: 'gemini-2.5-flash-image',
          description: 'Model (default: gemini-2.5-flash-image). FLUX models only via OpenRouter.'
        },
        aspectRatio: {
          type: 'string',
          enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
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
          enum: ['1K', '2K', '4K'],
          description: 'Image resolution. 4K only available for gemini-3-pro-image-preview'
        },
        referenceImages: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 14,
          description: 'Reference images for style/composition. Max 3 for 2.5-flash, max 14 for 3-pro'
        },
        savePath: {
          type: 'string',
          description: 'Vault-relative path where the image should be saved (e.g., "images/my-image.png")',
          pattern: '^[^/].*\\.(png|jpg|jpeg|webp)$'
        },
        format: {
          type: 'string',
          enum: ['png', 'jpeg', 'webp'],
          description: 'Image format (optional, inferred from savePath extension or provider default)'
        }
      },
      required: ['prompt', 'savePath']
    };

    return this.getMergedSchema(toolSchema);
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