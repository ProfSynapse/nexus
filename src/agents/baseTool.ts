import { ITool } from './interfaces/ITool';
import { CommonParameters, CommonResult } from '../types';
import {
  getCommonParameterSchema,
  getCommonResultSchema,
  createResult,
  mergeWithCommonSchema
} from '../utils/schemaUtils';
import { parseWorkspaceContext } from '../utils/contextUtils';
import { getErrorMessage } from '../utils/errorUtils';
import { enhanceSchemaDocumentation } from '../utils/validationUtils';

// Import new validation utilities
import {
  ValidationResultHelper,
  ValidationError,
  ValidationResult,
  ToolInterface
} from '../utils/validation/ValidationResultHelper';
import {
  CommonValidators,
  ValidationRuleSet
} from '../utils/validation/CommonValidators';

/**
 * Base class for all tools in the MCP plugin
 * Provides common functionality for tool implementation
 */
export abstract class BaseTool<T extends CommonParameters = CommonParameters, R extends CommonResult = CommonResult> implements ITool<T, R> {
  slug: string;
  name: string;
  description: string;
  version: string;

  /** Parent workspace context for session tracking */
  protected parentContext?: CommonResult['workspaceContext'];

  /** Session ID for tracking related operations */
  protected sessionId?: string;

  /**
   * Create a new tool
   * @param slug Slug of the tool (used for identification)
   * @param name Name of the tool
   * @param description Description of the tool
   * @param version Version of the tool
   */
  constructor(slug: string, name: string, description: string, version: string) {
    this.slug = slug;
    this.name = name;
    this.description = description;
    this.version = version;
  }

  /**
   * Execute the tool with parameters
   * @param params Parameters for the tool
   * @returns Promise that resolves with the tool's result
   */
  abstract execute(params: T): Promise<R>;

  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  abstract getParameterSchema(): any;

  /**
   * Get common parameter schema elements for workspace context
   * This is now a proxy to the central utility for DRY implementation
   * @returns JSON schema for common parameters
   */
  protected getCommonParameterSchema(): any {
    return getCommonParameterSchema();
  }

  /**
   * Get the JSON schema for the tool's result
   * @returns JSON schema object
   */
  getResultSchema(): any {
    // Default implementation returns the common result schema
    return getCommonResultSchema();
  }

  /**
   * Helper method to merge tool-specific schema with common schema and enhance documentation
   * This ensures that every tool has workspace context parameters,
   * and provides clear documentation on which parameters are required vs. optional
   *
   * @param customSchema The tool-specific schema
   * @returns Merged and enhanced schema with common parameters and improved documentation
   */
  protected getMergedSchema(customSchema: any): any {
    // Get the merged schema with common parameters
    const mergedSchema = mergeWithCommonSchema(customSchema);

    // Ensure the schema has a type and properties
    mergedSchema.type = mergedSchema.type || 'object';
    mergedSchema.properties = mergedSchema.properties || {};

    // Make sure workspaceContext is defined as optional property
    // This is a safety check in case it's not included in the common schema for some reason
    if (!mergedSchema.properties.workspaceContext) {
      mergedSchema.properties.workspaceContext = {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description: 'Workspace identifier'
          },
          workspacePath: {
            type: 'array',
            items: { type: 'string' },
            description: 'Path from root workspace to specific phase/task'
          },
          sessionId: {
            type: 'string',
            description: 'Session identifier to track related tool calls (required)'
          }
        },
        description: 'Optional workspace context'
      };
    }

    // Enhance schema with detailed documentation on required vs. optional parameters
    // and type information, to improve user experience
    return enhanceSchemaDocumentation(mergedSchema);
  }

  /**
   * Prepare a standardized result object
   * @param success Whether the operation was successful
   * @param data Operation-specific data
   * @param error Error message if operation failed
   * @param context Either a string with contextual information or a record of additional properties to include
   * @param workspaceContext Workspace context used
   * @returns Standardized result object
   */
  protected prepareResult(
    success: boolean,
    data?: any,
    error?: string,
    context?: CommonResult['context'],
    workspaceContext?: CommonResult['workspaceContext']
  ): R {
    // Extract sessionId from context parameter (DRY fix for all tools)
    let sessionId: string | undefined;

    if (context && typeof context === 'object' && 'sessionId' in context) {
      // New pattern: extract sessionId from context object
      sessionId = context.sessionId;
    } else {
      // Fallback: try to get from instance (backward compatibility)
      sessionId = this.sessionId;
    }

    if (!sessionId) {
      // Session ID is required, so we should report an error
      return createResult<R>(
        false,
        null,
        'Session ID is required but not provided'
      );
    }

    // Don't echo back context fields - the LLM already knows them since it passed them in.
    // Only return success, data, and error.
    return createResult<R>(
      success,
      data,
      error
    );
  }

  /**
   * Set parent workspace context for session tracking
   * This allows session IDs to be propagated between tools
   * @param context Parent workspace context
   */
  setParentContext(context: CommonResult['workspaceContext']): void {
    this.parentContext = context;
  }

  /**
   * Get the inherited workspace context
   * This method handles workspace context inheritance, where a child operation
   * can inherit context from its parent if not explicitly specified.
   *
   * Order of precedence:
   * 1. Current params.workspaceContext if explicitly provided
   * 2. Parent context from setParentContext if available
   * 3. Context from default session context
   *
   * @param params Parameters that may include workspaceContext
   * @returns The effective workspace context to use, or null if none available
   */
  protected getInheritedWorkspaceContext(params: CommonParameters): CommonResult['workspaceContext'] | null {
    // 1. Use explicitly provided context if available
    if (params.workspaceContext) {
      // Use the utility function to safely parse context
      const fallbackId = this.parentContext?.workspaceId || 'default-workspace';
      return parseWorkspaceContext(params.workspaceContext, fallbackId);
    }

    // 2. Fall back to parent context
    if (this.parentContext?.workspaceId) {
      return this.parentContext;
    }

    // 3. No context available
    return null;
  }


  // ========================================
  // VALIDATION UTILITIES
  // ========================================

  /**
   * Helper for standardized error responses
   *
   * Creates consistent error results using ValidationResultHelper while maintaining
   * backward compatibility with existing result creation patterns.
   *
   * @param error Error string, Error object, or array of ValidationErrors
   * @param params Original parameters (for context extraction)
   * @param context Additional context to include in result
   * @returns Standardized error result
   */
  protected createErrorResult(
    error: string | Error | ValidationError[],
    params?: T,
    context?: any
  ): R {
    return ValidationResultHelper.createErrorResult(this as ToolInterface, error, params, context);
  }

  /**
   * Helper for standardized success responses
   *
   * Creates consistent success results using ValidationResultHelper with proper
   * context propagation and session tracking.
   *
   * @param data Result data to include
   * @param params Original parameters (for context extraction)
   * @param additionalData Additional properties to include in result
   * @returns Standardized success result
   */
  protected createSuccessResult(
    data: any,
    params?: T,
    additionalData?: any
  ): R {
    return ValidationResultHelper.createSuccessResult(this as ToolInterface, data, params, additionalData);
  }

  /**
   * Enhanced validation execution pipeline
   *
   * Validates multiple fields using CommonValidators and returns a comprehensive
   * validation result with all errors collected.
   *
   * @param params Parameters object to validate
   * @param validators Mapping of field names to validation functions
   * @returns Validation result with success status and error details
   */
  protected validateCustom<TParams>(
    params: TParams,
    validators: ValidationRuleSet<TParams>
  ): ValidationResult<TParams> {
    const errors = CommonValidators.validateFields(params, validators);
    return ValidationResultHelper.createValidationResult(params, errors);
  }

  /**
   * Validate session context using standardized patterns
   *
   * Validates CommonParameters context structure using CommonValidators
   * with appropriate options for the current tool.
   *
   * @param params CommonParameters to validate
   * @param options Validation options (optional)
   * @returns Array of validation errors
   */
  protected validateSessionContext(
    params: CommonParameters,
    options?: {
      requireSessionId?: boolean;
      requireWorkspace?: boolean;
      minContextLength?: number;
    }
  ): ValidationError[] {
    return CommonValidators.validateSessionContext(params, this as ToolInterface, options);
  }

  /**
   * Helper for quick validation with automatic error result creation
   *
   * Combines validation and error result creation into a single method
   * for simpler error handling in tool implementations.
   *
   * @param params Parameters to validate
   * @param validators Validation rule set
   * @returns Error result if validation fails, null if valid
   */
  protected quickValidate<TParams>(
    params: TParams,
    validators: ValidationRuleSet<TParams>
  ): R | null {
    const validation = this.validateCustom(params, validators);
    if (!validation.success) {
      return this.createErrorResult(validation.errors, params as unknown as T);
    }
    return null;
  }
}
