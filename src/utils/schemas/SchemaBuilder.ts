/**
 * SchemaBuilder - Unified schema building system for all agent modes
 * Location: /src/utils/schemas/SchemaBuilder.ts
 *
 * This file consolidates 4 duplicate schema builders into a single, unified system:
 * - agentManager/modes/batchExecutePrompt/utils/SchemaBuilder.ts
 * - agentManager/modes/execute/services/SchemaBuilder.ts
 * - contentManager/modes/batch/schemas/SchemaBuilder.ts
 * - memoryManager/modes/session/create/services/SessionSchemaBuilder.ts
 *
 * Used by all agent modes requiring schema generation for MCP tool definitions.
 *
 * Refactored: Extracted concrete builders to separate files for better maintainability.
 */

import {
  SchemaType,
  SchemaContext,
  ISchemaBuilder,
  ProviderInfo,
  CommonSchemaProperties,
  SchemaValidationResult,
  SchemaStatistics
} from './SchemaTypes';
import { JSONSchema } from '../../types/schema/JSONSchemaTypes';

// Re-export SchemaType for consumers
export { SchemaType } from './SchemaTypes';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import { mergeWithCommonSchema } from '../schemaUtils';
import { ProviderInfoService } from './services/ProviderInfoService';
import { BatchExecuteSchemaBuilder } from './builders/BatchExecuteSchemaBuilder';
import { ExecuteSchemaBuilder } from './builders/ExecuteSchemaBuilder';
import { ContentBatchSchemaBuilder } from './builders/ContentBatchSchemaBuilder';
import { SessionSchemaBuilder } from './builders/SessionSchemaBuilder';

/**
 * Unified schema builder that handles all schema generation across the application
 * Eliminates code duplication and provides consistent schema patterns
 */
export class SchemaBuilder {
  private providerManager: LLMProviderManager | null;
  private providerInfoService: ProviderInfoService;

  constructor(providerManager?: LLMProviderManager | null) {
    this.providerManager = providerManager || null;
    this.providerInfoService = new ProviderInfoService(this.providerManager);
  }

  /**
   * Main entry point - builds schema based on type and context
   */
  static buildSchema(type: SchemaType, context: SchemaContext): {
    parameterSchema: any;
    resultSchema: any;
  } {
    const builder = new SchemaBuilder(context.providerManager);
    const concreteBuilder = builder.getBuilder(type);

    return {
      parameterSchema: concreteBuilder.buildParameterSchema(context),
      resultSchema: concreteBuilder.buildResultSchema(context)
    };
  }

  /**
   * Instance method for parameter schema building
   */
  buildParameterSchema(type: SchemaType, context: SchemaContext): any {
    const builder = this.getBuilder(type);
    return builder.buildParameterSchema(context);
  }

  /**
   * Instance method for result schema building
   */
  buildResultSchema(type: SchemaType, context: SchemaContext): any {
    const builder = this.getBuilder(type);
    return builder.buildResultSchema(context);
  }

  /**
   * Backward-compatible method for getting parameter schema (ContentBatch type)
   * Used by BatchContentMode
   */
  getParameterSchema(): JSONSchema {
    const context: SchemaContext = {
      mode: 'batchContent',
      providerManager: this.providerManager
    };
    return this.buildParameterSchema(SchemaType.ContentBatch, context);
  }

  /**
   * Backward-compatible method for getting result schema (ContentBatch type)
   * Used by BatchContentMode
   */
  getResultSchema(): JSONSchema {
    const context: SchemaContext = {
      mode: 'batchContent',
      providerManager: this.providerManager
    };
    return this.buildResultSchema(SchemaType.ContentBatch, context);
  }

  /**
   * Get specific builder for schema type
   */
  private getBuilder(type: SchemaType): ISchemaBuilder {
    switch (type) {
      case SchemaType.BatchExecute:
        return new BatchExecuteSchemaBuilder(this.providerManager);
      case SchemaType.Execute:
        return new ExecuteSchemaBuilder(this.providerManager);
      case SchemaType.ContentBatch:
        return new ContentBatchSchemaBuilder();
      case SchemaType.Session:
        return new SessionSchemaBuilder();
      default:
        throw new Error(`Unknown schema type: ${type}`);
    }
  }

  /**
   * Update provider manager instance
   */
  updateProviderManager(providerManager: LLMProviderManager | null): void {
    this.providerManager = providerManager;
    this.providerInfoService.updateProviderManager(providerManager);
  }

  /**
   * Get provider information for schema building
   */
  getProviderInfo(): ProviderInfo {
    return this.providerInfoService.getProviderInfo();
  }

  /**
   * Build common schema properties used across multiple types
   */
  buildCommonProperties(options: {
    includeProviders?: boolean;
    includeActions?: boolean;
  } = {}): CommonSchemaProperties {
    const properties: CommonSchemaProperties = {};

    if (options.includeProviders) {
      const providerInfo = this.getProviderInfo();
      const defaultModel = this.providerInfoService.getDefaultModel();

      properties.provider = {
        type: 'string',
        description: `LLM provider name (optional, defaults to: ${defaultModel?.provider || 'not configured'}). Use listModels to see available providers.`,
        default: defaultModel?.provider
      };

      properties.model = {
        type: 'string',
        description: `Model name (optional, defaults to: ${defaultModel?.model || 'not configured'}). Use listModels to see available models.`,
        default: defaultModel?.model
      };
    }

    if (options.includeActions) {
      properties.action = this.buildActionSchema();
    }

    return properties;
  }

  /**
   * Build action schema for content operations
   */
  private buildActionSchema(): any {
    return {
      type: 'object',
      description: 'Optional action to perform with the LLM response',
      properties: {
        type: {
          type: 'string',
          enum: ['create', 'append', 'prepend', 'replace', 'findReplace'],
          description: 'Type of content action to perform'
        },
        targetPath: {
          type: 'string',
          description: 'Path to the target file for the action'
        },
        position: {
          type: 'number',
          description: 'Line position for replace actions'
        },
        findText: {
          type: 'string',
          description: 'Text to find and replace (required for findReplace action)'
        },
        replaceAll: {
          type: 'boolean',
          description: 'Whether to replace all occurrences (default: false)',
          default: false
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Whether search is case sensitive (default: true)',
          default: true
        },
        wholeWord: {
          type: 'boolean',
          description: 'Whether to match whole words only (default: false)',
          default: false
        }
      },
      required: ['type', 'targetPath']
    };
  }

  /**
   * Validate schema configuration
   */
  validateConfiguration(): SchemaValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!this.providerManager) {
      warnings.push('Provider manager not available - schema will not include dynamic provider/model information');
    }

    const enabledProviders = this.providerInfoService.getEnabledProviders();
    if (enabledProviders.length === 0) {
      warnings.push('No providers are currently enabled - users may not be able to execute prompts');
    }

    const availableModels = this.providerInfoService.getAvailableModels();
    if (availableModels.length === 0) {
      warnings.push('No models are available - users may not be able to execute prompts');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Get schema building statistics
   */
  getStatistics(): SchemaStatistics {
    const providerInfo = this.getProviderInfo();

    return {
      parameterProperties: 0, // Will be set by concrete implementations
      resultProperties: 0, // Will be set by concrete implementations
      supportedTypes: Object.values(SchemaType),
      hasProviderManager: !!this.providerManager,
      enabledProvidersCount: providerInfo.enabledProviders.length,
      availableModelsCount: providerInfo.availableModels.length
    };
  }
}
