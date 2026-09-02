/**
 * Location: src/services/llm/types/ImageTypes.ts
 * 
 * Purpose: Comprehensive TypeScript types for image generation functionality
 * Integration: Extends existing LLM adapter architecture with image-specific operations
 * 
 * Used by:
 * - BaseImageAdapter: Abstract base class for image adapters
 * - OpenAIImageAdapter: OpenAI Images API (gpt-image-2 family)
 * - GeminiImageAdapter: Google Nano Banana (Gemini image) implementation
 * - ImageGenerationService: Core orchestration service
 * - ImageFileManager: Vault file operations
 * - GenerateImageMode: MCP interface mode
 */

import { CostDetails, LLMProviderError } from '../adapters/types';

// Core image generation parameter interfaces
export interface ImageGenerationParams {
  prompt: string;
  provider: 'google' | 'openrouter' | 'openai'; // Google direct, OpenRouter routing, or OpenAI direct
  model?: string; // Internal id from the adapter catalog, e.g. gemini-2.5-flash-image, flux-2-pro
  size?: string; // Legacy support for pixel dimensions (converted to aspectRatio)
  aspectRatio?: AspectRatio; // Nano Banana aspect ratios
  numberOfImages?: number; // 1-4 images
  imageSize?: NanoBananaImageSize; // Image resolution: 512px, 1K, 2K, or 4K (per-model availability)
  referenceImages?: string[]; // Vault-relative paths; per-model limit enforced by the adapter (3 for 2.5-flash, 14 for 3.x)
  savePath: string; // vault relative path
  sessionId?: string;
  context?: string;
}

// Nano Banana image resolution sizes
export type NanoBananaImageSize = '512px' | '1K' | '2K' | '4K';

// Image generation response from adapters
export interface ImageGenerationResponse {
  imageData: Buffer;
  format: 'png' | 'jpeg' | 'webp';
  dimensions: { width: number; height: number };
  metadata: Record<string, unknown>;
  usage?: ImageUsage;
  revisedPrompt?: string; // Some providers may revise the prompt
}

// Image-specific usage tracking
export interface ImageUsage {
  imagesGenerated: number;
  resolution: string;
  model: string;
  provider: string;
}

// Image model pricing structure
export interface ImageModelPricing {
  provider: string;
  model: string;
  costPerImage: number;
  costPerMegapixel?: number;
  currency: string;
  sizes: Record<string, number>; // size -> cost multiplier
  lastUpdated: string; // ISO date string
}

// Image cost calculation details
export interface ImageCostDetails extends Omit<CostDetails, 'rateInputPerMillion' | 'rateOutputPerMillion'> {
  ratePerImage: number;
  ratePerMegapixel?: number;
  resolution: string;
  imagesGenerated: number;
}

// Validation result for image parameters
export interface ImageValidationResult {
  isValid: boolean;
  errors: string[];
  warnings?: string[];
  adjustedParams?: Partial<ImageGenerationParams>;
}

// File save operation result
export interface ImageSaveResult {
  success: boolean;
  filePath: string;
  fileName: string;
  fileSize: number;
  dimensions: { width: number; height: number };
  format: string;
  error?: string;
}

// Complete image generation result
export interface ImageGenerationResult {
  success: boolean;
  data?: {
    imagePath: string;
    prompt: string;
    revisedPrompt?: string;
    model: string;
    provider: string;
    dimensions: { width: number; height: number };
    fileSize: number;
    format: string;
    cost?: ImageCostDetails;
    usage?: ImageUsage;
    metadata?: Record<string, unknown>;
  };
  error?: string;
  validationErrors?: string[];
}

// Provider-specific configuration
export interface ImageProviderConfig {
  provider: 'openai' | 'google';
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  defaultSize?: string;
  defaultQuality?: string;
  maxFileSize?: number; // bytes
  supportedFormats?: string[];
  supportedSizes?: string[];
  supportedQualities?: string[];
}

// Image buffer with metadata for internal processing
export interface ImageBuffer {
  data: Buffer;
  format: 'png' | 'jpeg' | 'webp';
  dimensions: { width: number; height: number };
  metadata: {
    prompt: string;
    revisedPrompt?: string;
    model: string;
    provider: string;
    generatedAt: string;
    fileSize: number;
    originalResponse?: Record<string, unknown>;
  };
}

// OpenAI specific types
export interface OpenAIImageGenerationRequest {
  model: 'gpt-5.2'; // Model that supports image_generation tool
  input: string;
  tools: Array<{
    type: 'image_generation';
    size?: '1024x1024' | '1536x1024' | '1024x1536' | 'auto';
    quality?: 'low' | 'medium' | 'high' | 'auto';
    background?: 'transparent' | 'opaque' | 'auto';
  }>;
}

export interface OpenAIImageGenerationResponse {
  created: number;
  data: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
}

// Google Nano Banana specific types
export interface GoogleRequestInlineDataPart {
  inline_data: {
    mime_type: string;
    data: string; // base64
  };
}

export interface GoogleRequestTextPart {
  text: string;
}

export type GoogleRequestPart = GoogleRequestInlineDataPart | GoogleRequestTextPart;

export interface GoogleRequestContent {
  parts: GoogleRequestPart[];
}

export interface GoogleImageConfig {
  aspectRatio?: string;
  imageSize?: '512' | '1K' | '2K' | '4K'; // wire value; '512px' is mapped to '512'
}

export interface GoogleImageGenerationRequest {
  model: string; // Gemini image model id, see GeminiImageAdapter.modelSpecs
  contents: GoogleRequestContent[];
  generationConfig?: {
    responseModalities?: ('TEXT' | 'IMAGE')[];
    imageConfig?: GoogleImageConfig;
  };
}

export interface GoogleSafetySetting {
  category: string;
  threshold: 'BLOCK_NONE' | 'BLOCK_LOW_AND_ABOVE' | 'BLOCK_MEDIUM_AND_ABOVE' | 'BLOCK_HIGH_AND_ABOVE';
}

export interface GoogleImageGenerationResponse {
  candidates: Array<{
    content?: {
      parts: Array<{
        inlineData?: {
          mimeType: string;
          data: string; // base64
        };
        text?: string;
      }>;
    };
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

// Image generation error types
export class ImageGenerationError extends LLMProviderError {
  constructor(
    message: string,
    provider: string,
    code?: string,
    originalError?: Error,
    public imageParams?: ImageGenerationParams
  ) {
    super(message, provider, code, originalError);
    this.name = 'ImageGenerationError';
  }
}

// Supported providers and models
export type ImageProvider = 'openai' | 'google' | 'openrouter';

export type ImageModel =
  | 'gpt-image-1'              // OpenAI GPT Image 1 (OpenAI direct)
  | 'gpt-image-1.5'            // OpenAI GPT Image 1.5 (OpenAI direct)
  | 'gpt-image-1-mini'         // OpenAI GPT Image 1 Mini (OpenAI direct)
  | 'gemini-2.5-flash-image'   // Google Nano Banana legacy, shuts down 2026-10-02
  | 'gemini-3-pro-image-preview' // Google Nano Banana Pro preview id
  | 'gemini-3.1-flash-image-preview' // Google Nano Banana 2 preview id
  | 'gpt-5-image'                    // OpenAI GPT-5 Image (OpenRouter only)
  | 'gpt-5.4-image-2'                // OpenAI GPT-5.4 Image 2 (OpenRouter only)
  | 'flux-2-pro'                     // Black Forest Labs FLUX.2 Pro (OpenRouter only)
  | 'flux-2-flex'                    // Black Forest Labs FLUX.2 Flex (OpenRouter only)
  | 'flux-2-klein-4b'                // Black Forest Labs FLUX.2 Klein 4B (OpenRouter only)
  | 'gemini-3.1-flash-image'         // Google Nano Banana 2, GA id (Google direct and OpenRouter)
  | 'gemini-3.1-flash-lite-image'    // Google Nano Banana 2 Lite, the default (Google direct and OpenRouter)
  | 'gemini-3-pro-image'             // Google Nano Banana Pro, GA id (Google direct and OpenRouter)
  | 'gpt-5-image-mini'               // OpenAI GPT-5 Image Mini (OpenRouter only)
  | 'gpt-image-2'                    // OpenAI GPT Image 2 (OpenRouter, and the OpenAI adapter)
  | 'seedream-4.5'                   // ByteDance Seedream 4.5 (OpenRouter only)
  | 'seedream-5-lite';               // ByteDance Seedream 5.0 Lite (OpenRouter only)

// Aspect ratio constants for Nano Banana models
export enum AspectRatio {
  SQUARE = '1:1',
  PORTRAIT_2_3 = '2:3',
  LANDSCAPE_3_2 = '3:2',
  PORTRAIT_3_4 = '3:4',
  LANDSCAPE_4_3 = '4:3',
  PORTRAIT_4_5 = '4:5',
  LANDSCAPE_5_4 = '5:4',
  PORTRAIT_9_16 = '9:16',
  LANDSCAPE_16_9 = '16:9',
  ULTRAWIDE_21_9 = '21:9',
  NARROW_1_4 = '1:4',
  WIDE_4_1 = '4:1',
  ULTRA_NARROW_1_8 = '1:8',
  ULTRA_WIDE_8_1 = '8:1'
}

// Image size presets
export const IMAGE_SIZES = {
  SQUARE_1024: '1024x1024',
  PORTRAIT: '1024x1536',  // Supported by both providers
  LANDSCAPE: '1536x1024', // Supported by both providers
  AUTO: 'auto'            // OpenAI automatic sizing
} as const;

export type ImageSize = typeof IMAGE_SIZES[keyof typeof IMAGE_SIZES];

// Image quality options
export const IMAGE_QUALITIES = {
  STANDARD: 'standard',
  HD: 'hd'
} as const;

export type ImageQuality = typeof IMAGE_QUALITIES[keyof typeof IMAGE_QUALITIES];

// Supported image formats
export const IMAGE_FORMATS = {
  PNG: 'png',
  JPEG: 'jpeg', 
  WEBP: 'webp'
} as const;

export type ImageFormat = typeof IMAGE_FORMATS[keyof typeof IMAGE_FORMATS];

// Safety levels for content filtering
export const SAFETY_LEVELS = {
  STRICT: 'strict',
  STANDARD: 'standard', 
  PERMISSIVE: 'permissive'
} as const;

export type SafetyLevel = typeof SAFETY_LEVELS[keyof typeof SAFETY_LEVELS];
