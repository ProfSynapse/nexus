import { CommonParameters } from '../../../../../types';
import { AspectRatio } from '../../../../../services/llm/types/ImageTypes';

/**
 * Parameters for batch LLM prompt execution
 * Now supports mixed text and image generation requests
 */
export interface BatchExecutePromptParams extends CommonParameters {
  /** Array of requests to execute - can be text prompts or image generation requests */
  prompts: Array<BatchRequest>;
  /** Whether to merge all responses into a single result */
  mergeResponses?: boolean;
}

/**
 * Base interface for batch requests
 */
export interface BaseBatchRequest {
  /** Custom identifier for this request */
  id?: string;
  /** Sequence number for ordered execution (sequences execute in numerical order: 0, 1, 2, etc.) */
  sequence?: number;
  /** Parallel group within sequence - requests with same parallelGroup run together */
  parallelGroup?: string;
  /** Whether to include previous step results as context */
  includePreviousResults?: boolean;
  /** Specific IDs of previous steps to include as context */
  contextFromSteps?: string[];
}

/**
 * Text prompt request for LLM generation
 */
export interface TextPromptRequest extends BaseBatchRequest {
  /** Request type identifier */
  type: 'text';
  /** The prompt text to send to the LLM */
  prompt: string;
  /** Optional provider to use (defaults to settings default) */
  provider?: string;
  /** Optional model to use (defaults to settings default) */
  model?: string;
  /** Optional context files to include */
  contextFiles?: string[];
  /** Optional workspace for context */
  workspace?: string;
  /** Optional action to perform with the LLM response */
  action?: ContentAction;
  /** Optional custom prompt to use (by name or ID) */
  customPrompt?: string;
}

/**
 * Image generation request
 */
export interface ImageGenerationRequest extends BaseBatchRequest {
  /** Request type identifier */
  type: 'image';
  /** The prompt text describing the image to generate */
  prompt: string;
  /** Image generation provider (google for Imagen, openai disabled for now) */
  provider: 'google'; // Only Google supported currently due to OpenAI speed issues
  /** Optional model to use (imagen-4, imagen-4-ultra) */
  model?: 'imagen-4' | 'imagen-4-ultra';
  /** Image aspect ratio */
  aspectRatio?: AspectRatio;
  /** Vault-relative path where the image should be saved */
  savePath: string;
  /** Reference images for style/composition guidance (vault-relative paths). Max 3 for gemini-2.5-flash-image, max 14 for gemini-3-pro-image-preview */
  referenceImages?: string[];
}

/**
 * Union type for all batch request types
 */
export type BatchRequest = TextPromptRequest | ImageGenerationRequest;

/**
 * Individual request configuration for execution (unified for text and image)
 */
export type PromptConfig = TextPromptConfig | ImagePromptConfig;

/**
 * Text prompt configuration for execution
 */
export interface TextPromptConfig {
  type: 'text';
  prompt: string;
  provider?: string;
  model?: string;
  contextFiles?: string[];
  workspace?: string;
  id?: string;
  sequence?: number;
  parallelGroup?: string;
  includePreviousResults?: boolean;
  contextFromSteps?: string[];
  action?: ContentAction;
  customPrompt?: string;
}

/**
 * Image generation configuration for execution
 */
export interface ImagePromptConfig {
  type: 'image';
  prompt: string;
  provider: 'google';
  model?: 'imagen-4' | 'imagen-4-ultra';
  aspectRatio?: AspectRatio;
  savePath: string;
  /** Reference images for style/composition guidance (vault-relative paths) */
  referenceImages?: string[];
  id?: string;
  sequence?: number;
  parallelGroup?: string;
  includePreviousResults?: boolean;
  contextFromSteps?: string[];
}

/**
 * Content action configuration
 */
export interface ContentAction {
  type: 'create' | 'append' | 'prepend' | 'replace' | 'findReplace';
  targetPath: string;
  position?: number;
  findText?: string;
  replaceAll?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

/**
 * Execution context for prompt processing (uses internal results during execution)
 */
export interface ExecutionContext {
  sessionId?: string;
  context?: unknown;
  previousResults: Map<number, InternalExecutionResult[]>;
  allResults: InternalExecutionResult[];
}

/**
 * Parameters for individual prompt execution
 */
export interface PromptExecutionParams {
  systemPrompt: string;
  userPrompt: string;
  filepaths?: string[];
  provider?: string;
  model?: string;
  workspace?: string;
  sessionId?: string;
}

/**
 * Result from individual request execution (lean)
 * Infer type from fields: response/savedTo = text, imagePath = image
 */
export interface PromptExecutionResult {
  success: boolean;
  /** Text response - omitted if action saved content to note */
  response?: string;
  /** Path where content was saved (text with action) */
  savedTo?: string;
  /** Path where image was saved */
  imagePath?: string;
  /** Only included on failure */
  error?: string;
}

/**
 * Internal result with full details (used during execution, stripped before return)
 */
export interface InternalExecutionResult {
  type: 'text' | 'image';
  id?: string;
  prompt: string;
  success: boolean;
  response?: string;
  imagePath?: string;
  provider?: string;
  model?: string;
  /** Name of the custom prompt used (if any) */
  promptName?: string;
  error?: string;
  executionTime?: number;
  sequence?: number;
  parallelGroup?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    imagesGenerated?: number;
    resolution?: string;
  };
  cost?: {
    inputCost: number;
    outputCost: number;
    totalCost: number;
    currency: string;
  };
  filesIncluded?: string[];
  actionPerformed?: {
    type: string;
    targetPath: string;
    success: boolean;
    error?: string;
  };
}