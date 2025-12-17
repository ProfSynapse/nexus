/**
 * Location: /src/utils/validation/ValidationResultHelper.ts
 * Purpose: Centralized result creation patterns to ensure consistency across all modes
 * 
 * This utility provides standardized methods for creating error and success results,
 * ensuring consistent error handling, context extraction, and response formatting
 * across all agents and modes.
 * 
 * Used by: All BaseMode implementations for standardized result creation
 * Integrates with: BaseMode, CommonParameters, CommonResult, contextUtils
 */

import { CommonParameters, CommonResult } from '../../types/mcp/AgentTypes';
import { extractContextFromParams, WorkspaceContext } from '../contextUtils';
import { getErrorMessage } from '../errorUtils';
import { createResult } from '../schemaUtils';

/**
 * Type for BaseMode interface without direct import to avoid file casing conflicts
 * Exported for use by BaseMode and other classes that need to match this interface
 */
export interface ModeInterface {
  slug: string;
  name: string;
  description: string;
  version: string;
  constructor: { name: string };
}

/**
 * Validation error interface for detailed error reporting
 */
export interface ValidationError {
  /**
   * Path to the field that failed validation (e.g., ['name'] or ['workspaceContext', 'workspaceId'])
   */
  path: string[];
  
  /**
   * Human-readable error message
   */
  message: string;
  
  /**
   * Machine-readable error code for categorization
   */
  code: string;
  
  /**
   * Optional hint to help users resolve the issue
   */
  hint?: string;
  
  /**
   * Error severity level
   */
  severity?: 'error' | 'warning';
  
  /**
   * Additional context information
   */
  context?: Record<string, any>;
}

/**
 * Validation result interface for comprehensive validation outcomes
 */
export interface ValidationResult<T> {
  /**
   * Whether validation succeeded
   */
  success: boolean;
  
  /**
   * Validated data (original or transformed)
   */
  data: T;
  
  /**
   * Array of validation errors
   */
  errors: ValidationError[];
  
  /**
   * Optional warnings that don't prevent success
   */
  warnings?: string[];
  
  /**
   * Optional metadata about the validation process
   */
  metadata?: ValidationMetadata;
}

/**
 * Metadata about the validation process
 */
export interface ValidationMetadata {
  /**
   * Time taken to perform validation (milliseconds)
   */
  duration?: number;

  /**
   * Number of fields validated
   */
  fieldCount?: number;

  /**
   * Whether fallback validation was used
   */
  usedFallback?: boolean;

  /**
   * Additional context-specific metadata
   */
  [key: string]: any;
}

/**
 * Interface for CompatibilityMonitor if available on globalThis
 */
interface CompatibilityMonitor {
  trackValidation(
    component: string,
    operation: string,
    startTime: number,
    endTime: number,
    success: boolean
  ): void;
}

/**
 * Extended globalThis interface with optional CompatibilityMonitor
 */
interface GlobalWithMonitor {
  CompatibilityMonitor?: CompatibilityMonitor;
}

/**
 * Context extraction result
 */
interface ContextExtractionResult {
  sessionId?: string;
  workspaceContext?: WorkspaceContext;
  contextString?: string;
}

/**
 * ValidationResultHelper - Centralized result creation for consistent error and success handling
 */
export class ValidationResultHelper {
  /**
   * Create standardized error result with automatic context handling
   * 
   * This method provides consistent error formatting across all modes, ensuring
   * proper session tracking, workspace context handling, and error message formatting.
   * 
   * @param mode The mode instance creating the result
   * @param error Error string, Error object, or array of ValidationErrors
   * @param params Original parameters (for context extraction)
   * @param additionalContext Additional context to include in result
   * @returns Standardized error result
   */
  static createErrorResult<TResult extends CommonResult>(
    mode: ModeInterface,
    error: string | Error | ValidationError[],
    params?: CommonParameters,
    additionalContext?: Record<string, any>
  ): TResult {
    const startTime = performance.now();
    
    try {
      // Extract context information
      const contextResult = this.extractAndValidateContext(params, mode);
      
      // Format error message
      let errorMessage: string;
      let errorCode: string = 'VALIDATION_ERROR';
      let errorDetails: any = {};
      
      if (Array.isArray(error)) {
        // Handle ValidationError array
        const primaryErrors = error.filter(e => e.severity !== 'warning');
        if (primaryErrors.length > 0) {
          errorMessage = primaryErrors.map(e => e.message).join('; ');
          errorCode = primaryErrors[0].code || 'VALIDATION_ERROR';
          errorDetails = {
            validationErrors: error,
            errorCount: primaryErrors.length,
            warningCount: error.filter(e => e.severity === 'warning').length
          };
        } else {
          errorMessage = 'Validation failed with warnings';
          errorDetails = { validationErrors: error };
        }
      } else if (error instanceof Error) {
        errorMessage = error.message;
        errorCode = error.name || 'ERROR';
        errorDetails = {
          errorType: error.constructor.name,
          stack: error.stack
        };
      } else {
        errorMessage = error;
      }
      
      // Track error creation performance
      this.trackPerformance(
        mode.constructor.name,
        'error-result-creation',
        startTime,
        false,
        { errorCode, hasValidationErrors: Array.isArray(error) }
      );
      
      // Create standardized result - don't echo back context fields the LLM already knows
      return createResult<TResult>(
        false,
        null,
        errorMessage,
        undefined,
        undefined,
        undefined,
        {
          errorCode,
          errorDetails,
          timestamp: Date.now(),
          mode: mode.name,
          ...additionalContext
        }
      );
      
    } catch (resultError) {
      // Fallback error creation if the main process fails
      console.error(`Error creating error result in ${mode.constructor.name}:`, resultError);
      
      return createResult<TResult>(
        false,
        null,
        `Error creating error result: ${getErrorMessage(resultError)}. Original error: ${getErrorMessage(error)}`,
        undefined,
        undefined,
        undefined,
        undefined
      );
    }
  }
  
  /**
   * Create standardized success result with context propagation
   * 
   * Ensures consistent success result formatting with proper context handling
   * and session tracking across all modes.
   * 
   * @param mode The mode instance creating the result
   * @param data Result data to include
   * @param params Original parameters (for context extraction)
   * @param additionalData Additional properties to include in result
   * @returns Standardized success result
   */
  static createSuccessResult<TResult extends CommonResult>(
    mode: ModeInterface,
    data: any,
    params?: CommonParameters,
    additionalData?: Record<string, any>
  ): TResult {
    const startTime = performance.now();
    
    try {
      // Extract context information
      const contextResult = this.extractAndValidateContext(params, mode);
      
      // Track success result creation performance
      this.trackPerformance(
        mode.constructor.name,
        'success-result-creation',
        startTime,
        true,
        { hasData: !!data, dataType: typeof data }
      );
      
      // Create standardized result - don't echo back context fields the LLM already knows
      return createResult<TResult>(
        true,
        data,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          timestamp: Date.now(),
          mode: mode.name,
          ...additionalData
        }
      );
      
    } catch (resultError) {
      console.error(`Error creating success result in ${mode.constructor.name}:`, resultError);
      
      // Fallback to error result if success result creation fails
      return this.createErrorResult(
        mode,
        `Error creating success result: ${getErrorMessage(resultError)}`,
        params
      );
    }
  }
  
  /**
   * Create validation result for field-level validation operations
   * 
   * @param data Original data being validated
   * @param errors Array of validation errors
   * @param warnings Optional array of warnings
   * @param metadata Optional validation metadata
   * @returns Validation result
   */
  static createValidationResult<T>(
    data: T,
    errors: ValidationError[] = [],
    warnings?: string[],
    metadata?: ValidationMetadata
  ): ValidationResult<T> {
    return {
      success: errors.filter(e => e.severity !== 'warning').length === 0,
      data,
      errors,
      warnings,
      metadata
    };
  }
  
  /**
   * Extract and validate session context from parameters
   * 
   * Handles the complex logic of extracting session IDs, workspace context,
   * and contextual information from parameters with proper fallbacks.
   * 
   * @param params Parameters to extract context from
   * @param mode Mode instance for context inheritance
   * @returns Extracted context information
   */
  private static extractAndValidateContext(
    params?: CommonParameters,
    mode?: ModeInterface
  ): ContextExtractionResult {
    const result: ContextExtractionResult = {};
    
    if (!params) {
      return result;
    }
    
    // Extract session ID from context
    if (params.context?.sessionId) {
      result.sessionId = params.context.sessionId;
    }
    
    // Extract workspace context from params if available
    // Note: We only extract from params here. BaseMode's getInheritedWorkspaceContext
    // handles inheritance logic internally, but we don't call it directly as it's protected.
    if (params.workspaceContext) {
      try {
        // If it's already an object, use it directly; otherwise it might be a string representation
        if (typeof params.workspaceContext === 'object') {
          result.workspaceContext = params.workspaceContext;
        }
      } catch (error) {
        console.warn('Error extracting workspace context:', error);
      }
    }
    
    // Extract context string from parameters
    if (params.context) {
      if (typeof params.context === 'string') {
        result.contextString = params.context;
      } else {
        // Convert rich context object to string
        const contextResult = extractContextFromParams(params);
        if (typeof contextResult === 'string') {
          result.contextString = contextResult;
        } else if (contextResult) {
          // Convert object to readable string
          result.contextString = Object.entries(contextResult)
            .filter(([_, value]) => value)
            .map(([key, value]) => `${key}: ${value}`)
            .join(', ');
        }
      }
    }
    
    return result;
  }
  
  /**
   * Track performance metrics for validation operations
   *
   * Integrates with existing CompatibilityMonitor system when available
   *
   * @param modeName Name of the mode performing validation
   * @param operation Type of operation being tracked
   * @param startTime Start time of the operation
   * @param success Whether the operation succeeded
   * @param metadata Additional metadata to track
   */
  private static trackPerformance(
    modeName: string,
    operation: string,
    startTime: number,
    success: boolean,
    metadata?: Record<string, any>
  ): void {
    const duration = performance.now() - startTime;

    // Integration with existing CompatibilityMonitor if available
    // Type-safe access using defined interface
    const global = globalThis as GlobalWithMonitor;
    if (global.CompatibilityMonitor) {
      global.CompatibilityMonitor.trackValidation(
        `ValidationResultHelper_${modeName}`,
        operation,
        startTime,
        performance.now(),
        success
      );
    }

    // Additional performance logging for debugging
    if (duration > 10) { // Log slow operations (>10ms)
      console.debug(`ValidationResultHelper: ${operation} in ${modeName} took ${duration.toFixed(2)}ms`, {
        success,
        metadata
      });
    }
  }
}