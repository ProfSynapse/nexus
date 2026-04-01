/**
 * SchemaTypes - Centralized type definitions for unified schema builder system
 * Location: /src/utils/schemas/SchemaTypes.ts
 * 
 * This file provides type definitions and enums for the unified schema builder,
 * consolidating patterns from 4 duplicate schema builders across the codebase.
 * Used by SchemaBuilder.ts to maintain type safety and consistent schema generation.
 */

import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';

/**
 * Schema types supported by the unified builder
 */
export const SchemaType = {
  BatchExecute: 'batchExecute',
  Execute: 'execute', 
  ContentBatch: 'contentBatch',
  Session: 'session',
  State: 'state'
} as const;

export type SchemaType = typeof SchemaType[keyof typeof SchemaType];

/**
 * Context information for schema building
 */
export interface SchemaContext {
  mode: string;
  parameters?: Record<string, unknown>;
  options?: SchemaOptions;
  providerManager?: LLMProviderManager | null;
}

/**
 * Options for customizing schema generation
 */
export interface SchemaOptions {
  includeProviderInfo?: boolean;
  includeActions?: boolean;
  includeSession?: boolean;
  includeWorkspace?: boolean;
  maxItems?: number;
  minItems?: number;
}

/**
 * Base interface for all schema builders
 */
export interface ISchemaBuilder {
  buildParameterSchema(context: SchemaContext): Record<string, unknown>;
  buildResultSchema(context: SchemaContext): Record<string, unknown>;
}

/**
 * Provider and model information for dynamic schemas
 */
export interface ProviderInfo {
  enabledProviders: string[];
  availableModels: string[];
  hasProviderManager: boolean;
}

/**
 * Action schema configuration
 */
export interface ActionConfig {
  type: 'create' | 'append' | 'prepend' | 'replace' | 'findReplace';
  targetPath: string;
  position?: number;
  findText?: string;
  replaceAll?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

/**
 * Content operation types for batch operations
 */
export type ContentOperationType = 
  | 'read' 
  | 'create' 
  | 'append' 
  | 'prepend' 
  | 'replace' 
  | 'replaceByLine' 
  | 'delete' 
  | 'findReplace';

/**
 * Session context depth options
 */
export type ContextDepth = 'minimal' | 'standard' | 'comprehensive';

/**
 * Execution sequence configuration
 */
export interface SequenceConfig {
  sequence?: number;
  parallelGroup?: string;
  includePreviousResults?: boolean;
  contextFromSteps?: string[];
}

/**
 * Usage and cost information
 */
export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CostInfo {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
}

/**
 * Common schema properties that appear across multiple schema types
 */
export interface CommonSchemaProperties {
  // Provider/Model properties
  provider?: {
    type: string;
    description: string;
    enum?: string[];
    examples?: string[];
    default?: string;
  };
  model?: {
    type: string;
    description: string;
    enum?: string[];
    examples?: string[];
    default?: string;
  };
  
  // Action properties
  action?: Record<string, unknown>;
  
  // Session properties
  sessionId?: {
    type: string;
    description: string;
  };
  
  // Workspace properties
  workspaceContext?: Record<string, unknown>;
  
  // Context properties
  context?: Record<string, unknown> | string;
}

/**
 * Schema validation result
 */
export interface SchemaValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Schema builder statistics
 */
export interface SchemaStatistics {
  parameterProperties: number;
  resultProperties: number;
  supportedTypes: SchemaType[];
  hasProviderManager: boolean;
  enabledProvidersCount: number;
  availableModelsCount: number;
}
