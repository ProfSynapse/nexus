/**
 * Location: /src/utils/validation/CommonValidators.ts
 * Purpose: Reusable validation functions for the most common parameter patterns
 * 
 * This utility provides standardized validation functions that eliminate duplication
 * across modes by centralizing common validation patterns like required strings,
 * file paths, session context, and other frequently validated parameter types.
 * 
 * Used by: All modes for parameter validation via BaseMode.validateCustom()
 * Integrates with: ValidationResultHelper, BaseMode, CommonParameters
 */

import { CommonParameters } from '../../types/mcp/AgentTypes';
import { ValidationError } from './ValidationResultHelper';

/**
 * String validation options interface
 */
export interface StringValidationOptions {
  /**
   * Minimum length (default: 1)
   */
  minLength?: number;
  
  /**
   * Maximum length (default: 500)
   */
  maxLength?: number;
  
  /**
   * Allow empty strings (default: false)
   */
  allowEmpty?: boolean;
  
  /**
   * Trim whitespace before validation (default: true)
   */
  trimWhitespace?: boolean;
  
  /**
   * Regular expression pattern to match
   */
  pattern?: string;
  
  /**
   * Hint for pattern requirements
   */
  patternHint?: string;
}

/**
 * File path validation options interface
 */
export interface FilePathValidationOptions {
  /**
   * Apply Obsidian-specific validation rules (default: true)
   */
  obsidianValidation?: boolean;
  
  /**
   * Allow glob patterns like *.md (default: false)
   */
  allowGlobs?: boolean;
  
  /**
   * Allow directory paths (default: true)
   */
  allowDirectories?: boolean;
  
  /**
   * Required file extension
   */
  requiredExtension?: string;
  
  /**
   * Maximum path length (default: 1000)
   */
  maxLength?: number;
}

/**
 * Session context validation options interface
 */
export interface SessionContextOptions {
  /**
   * Require session ID to be present (default: true)
   */
  requireSessionId?: boolean;
  
  /**
   * Require workspace context (default: false)
   */
  requireWorkspace?: boolean;
  
  /**
   * Minimum length for context fields (default: 5)
   */
  minContextLength?: number;
}

/**
 * Validation rule function type
 */
export type ValidationRule<T> = (value: any, fieldName: string) => ValidationError | null;

/**
 * Validation rule set type
 */
export type ValidationRuleSet<T> = {
  [K in keyof T]?: ValidationRule<T[K]>;
};

/**
 * CommonValidators - Centralized validation utilities for common parameter patterns
 */
export class CommonValidators {
  /**
   * Validate required string with comprehensive error reporting
   * 
   * Provides detailed validation for string fields with customizable constraints
   * and consistent error messaging across all modes.
   * 
   * @param value Value to validate
   * @param fieldName Name of the field being validated
   * @param options Validation options
   * @returns ValidationError if validation fails, null if valid
   */
  static requiredString(
    value: any,
    fieldName: string,
    options: StringValidationOptions = {}
  ): ValidationError | null {
    const opts: Required<StringValidationOptions> = {
      minLength: 1,
      maxLength: 500,
      allowEmpty: false,
      trimWhitespace: true,
      pattern: undefined as unknown as string,
      patternHint: undefined as unknown as string,
      ...options
    };

    // Check for null/undefined
    if (value === null || value === undefined) {
      return this.createFieldError(fieldName, 'FIELD_REQUIRED', 
        `${fieldName} is required`, 'Please provide a value');
    }

    // Check type
    if (typeof value !== 'string') {
      return this.createFieldError(fieldName, 'TYPE_ERROR',
        `${fieldName} must be a string`, 
        `Expected string, received ${typeof value}`);
    }

    const processedValue = opts.trimWhitespace ? value.trim() : value;

    // Check empty string
    if (!opts.allowEmpty && processedValue.length === 0) {
      return this.createFieldError(fieldName, 'EMPTY_STRING',
        `${fieldName} cannot be empty`,
        'Please provide a non-empty value');
    }

    // Check minimum length
    if (processedValue.length < opts.minLength) {
      return this.createFieldError(fieldName, 'MIN_LENGTH',
        `${fieldName} must be at least ${opts.minLength} characters`,
        `Current length: ${processedValue.length}`);
    }

    // Check maximum length
    if (processedValue.length > opts.maxLength) {
      return this.createFieldError(fieldName, 'MAX_LENGTH',
        `${fieldName} must not exceed ${opts.maxLength} characters`,
        `Current length: ${processedValue.length}`);
    }

    // Check pattern
    if (opts.pattern && !new RegExp(opts.pattern).test(processedValue)) {
      return this.createFieldError(fieldName, 'PATTERN_MISMATCH',
        `${fieldName} format is invalid`,
        opts.patternHint || 'Please check the required format');
    }

    return null;
  }

  /**
   * Validate file path with Obsidian-specific constraints
   * 
   * Handles file path validation including Obsidian-specific rules for
   * invalid characters, reserved names, and path length constraints.
   * 
   * @param value Value to validate
   * @param fieldName Name of the field being validated
   * @param options Validation options
   * @returns ValidationError if validation fails, null if valid
   */
  static filePath(
    value: any, 
    fieldName: string = 'filePath',
    options: FilePathValidationOptions = {}
  ): ValidationError | null {
    // First validate as required string
    const stringError = this.requiredString(value, fieldName, {
      minLength: 1,
      maxLength: options.maxLength || 1000
    });
    if (stringError) return stringError;

    const path = value.trim();
    
    // Obsidian-specific file path validation
    if (options.obsidianValidation !== false) {
      // Check for invalid characters in Obsidian file paths
      const invalidChars = /[<>:"|?*\u0000-\u001f]/;
      if (!options.allowGlobs && invalidChars.test(path)) {
        return this.createFieldError(fieldName, 'INVALID_PATH_CHARS',
          `${fieldName} contains invalid characters`,
          'File paths cannot contain: < > : " | ? * or control characters');
      }

      // Allow glob patterns if specified
      if (options.allowGlobs) {
        const invalidGlobChars = /[<>:"|]/;
        if (invalidGlobChars.test(path)) {
          return this.createFieldError(fieldName, 'INVALID_GLOB_CHARS',
            `${fieldName} contains invalid characters for glob patterns`,
            'Glob patterns cannot contain: < > : " | or control characters');
        }
      }

      // Check for reserved names (Windows-specific but good practice)
      const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
      const fileName = path.split(/[/\\]/).pop() || '';
      if (reservedNames.test(fileName)) {
        return this.createFieldError(fieldName, 'RESERVED_NAME',
          `${fieldName} uses a reserved file name`,
          'Avoid reserved names like CON, PRN, AUX, etc.');
      }
    }

    // Check required extension
    if (options.requiredExtension && !path.toLowerCase().endsWith(`.${options.requiredExtension.toLowerCase()}`)) {
      return this.createFieldError(fieldName, 'MISSING_EXTENSION',
        `${fieldName} must have .${options.requiredExtension} extension`,
        `Add .${options.requiredExtension} to the file path`);
    }

    return null;
  }

  /**
   * Validate session context (common across all modes)
   * 
   * Validates the CommonParameters context structure including session ID,
   * workspace context, and other contextual information required for proper
   * session tracking and tool operation.
   * 
   * @param params CommonParameters to validate
   * @param mode Mode instance for context inheritance
   * @param options Validation options
   * @returns Array of validation errors
   */
  static validateSessionContext(
    params: CommonParameters,
    mode?: unknown,
    options: SessionContextOptions = {}
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const opts: Required<SessionContextOptions> = {
      requireSessionId: true,
      requireWorkspace: false,
      minContextLength: 5,
      ...options
    };

    // Validate context object structure
    if (!params.context) {
      if (opts.requireSessionId) {
        errors.push(this.createFieldError(
          'context',
          'CONTEXT_REQUIRED',
          'Context object is required',
          'Provide context with sessionId and other required fields'
        ));
      }
      return errors;
    }

    // Session ID validation
    if (opts.requireSessionId) {
      const sessionId = params.context.sessionId;
      if (!sessionId) {
        errors.push(this.createFieldError(
          'context.sessionId',
          'SESSION_ID_REQUIRED',
          'Session ID is required for tool tracking',
          'Ensure context.sessionId is provided'
        ));
      } else if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        errors.push(this.createFieldError(
          'context.sessionId',
          'SESSION_ID_INVALID',
          'Session ID must be a non-empty string',
          'Provide a valid session identifier'
        ));
      }
    }

    // Workspace ID validation (required in context)
    if (!params.context.workspaceId) {
      errors.push(this.createFieldError(
        'context.workspaceId',
        'WORKSPACE_ID_REQUIRED',
        'Workspace ID is required in context',
        'Provide workspaceId in the context object'
      ));
    }

    // Validate context field lengths
    const contextFields = [
      { key: 'sessionDescription', name: 'Session description' },
      { key: 'sessionMemory', name: 'Session memory' },
      { key: 'toolContext', name: 'Tool context' },
      { key: 'primaryGoal', name: 'Primary goal' },
      { key: 'subgoal', name: 'Subgoal' }
    ];

    for (const field of contextFields) {
      const contextObj = params.context as Record<string, unknown>;
      const value = contextObj[field.key];
      if (value !== undefined && (typeof value !== 'string' || value.trim().length < opts.minContextLength)) {
        errors.push(this.createFieldError(
          `context.${field.key}`,
          'CONTEXT_FIELD_TOO_SHORT',
          `${field.name} must be at least ${opts.minContextLength} characters`,
          `Provide meaningful ${field.name.toLowerCase()}`
        ));
      }
    }

    // Workspace context validation if required
    if (opts.requireWorkspace && mode) {
      const modeObj = mode as { getInheritedWorkspaceContext?: (params: CommonParameters) => unknown };
      if (typeof modeObj.getInheritedWorkspaceContext === 'function') {
        try {
          const workspaceContext = modeObj.getInheritedWorkspaceContext(params) as { workspaceId?: string } | undefined;
          if (!workspaceContext?.workspaceId) {
            errors.push(this.createFieldError(
              'workspaceContext',
              'WORKSPACE_CONTEXT_REQUIRED',
              'Workspace context is required',
              'Provide workspaceContext or ensure inherited context is available'
            ));
          }
        } catch (error) {
        }
      }
    }

    return errors;
  }

  /**
   * Batch field validation with comprehensive error collection
   * 
   * Validates multiple fields using provided validators and collects all errors
   * in a single pass, providing comprehensive validation feedback.
   * 
   * @param params Object containing fields to validate
   * @param validators Mapping of field names to validation functions
   * @returns Array of validation errors
   */
  static validateFields<T>(
    params: T,
    validators: ValidationRuleSet<T>
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const startTime = performance.now();

    for (const [fieldName, validator] of Object.entries(validators)) {
      try {
        if (typeof validator === 'function') {
          const paramsObj = params as Record<string, unknown>;
          const fieldValue = paramsObj[fieldName];
          const error = validator(fieldValue, fieldName);
          if (error) {
            errors.push(error);
          }
        }
      } catch (validationError) {
        errors.push(this.createFieldError(
          fieldName,
          'VALIDATION_ERROR',
          `Validation failed for ${fieldName}`,
          String(validationError)
        ));
      }
    }

    // Track validation performance
    this.trackValidationPerformance('validateFields', startTime, errors.length === 0);

    return errors;
  }

  /**
   * Validate boolean flag with type checking
   * 
   * @param value Value to validate
   * @param fieldName Name of the field being validated
   * @param required Whether the field is required
   * @returns ValidationError if validation fails, null if valid
   */
  static booleanFlag(
    value: any,
    fieldName: string,
    required: boolean = false
  ): ValidationError | null {
    if (value === undefined || value === null) {
      if (required) {
        return this.createFieldError(fieldName, 'FIELD_REQUIRED',
          `${fieldName} is required`, 'Provide true or false');
      }
      return null;
    }

    if (typeof value !== 'boolean') {
      return this.createFieldError(fieldName, 'TYPE_ERROR',
        `${fieldName} must be a boolean`, 
        `Expected true or false, received ${typeof value}`);
    }

    return null;
  }

  /**
   * Validate numeric value with range constraints
   * 
   * @param value Value to validate
   * @param fieldName Name of the field being validated
   * @param options Validation options
   * @returns ValidationError if validation fails, null if valid
   */
  static numericValue(
    value: any,
    fieldName: string,
    options: {
      minimum?: number;
      maximum?: number;
      integer?: boolean;
      required?: boolean;
    } = {}
  ): ValidationError | null {
    if (value === undefined || value === null) {
      if (options.required) {
        return this.createFieldError(fieldName, 'FIELD_REQUIRED',
          `${fieldName} is required`, 'Provide a numeric value');
      }
      return null;
    }

    if (typeof value !== 'number' || isNaN(value)) {
      return this.createFieldError(fieldName, 'TYPE_ERROR',
        `${fieldName} must be a number`, 
        `Expected number, received ${typeof value}`);
    }

    if (options.integer && !Number.isInteger(value)) {
      return this.createFieldError(fieldName, 'INTEGER_REQUIRED',
        `${fieldName} must be an integer`, 
        `Received ${value}, expected whole number`);
    }

    if (options.minimum !== undefined && value < options.minimum) {
      return this.createFieldError(fieldName, 'MINIMUM_VALUE',
        `${fieldName} must be at least ${options.minimum}`,
        `Current value: ${value}`);
    }

    if (options.maximum !== undefined && value > options.maximum) {
      return this.createFieldError(fieldName, 'MAXIMUM_VALUE',
        `${fieldName} must not exceed ${options.maximum}`,
        `Current value: ${value}`);
    }

    return null;
  }

  /**
   * Extract session ID from CommonParameters
   * 
   * Helper method to safely extract session ID with fallbacks
   * 
   * @param params CommonParameters to extract from
   * @returns Session ID or undefined
   */
  static extractSessionId(params: CommonParameters): string | undefined {
    return params.context?.sessionId;
  }

  /**
   * Create standardized field error
   * 
   * @param fieldName Name of the field that failed validation
   * @param code Machine-readable error code
   * @param message Human-readable error message
   * @param hint Optional hint to help resolve the issue
   * @returns ValidationError object
   */
  private static createFieldError(
    fieldName: string,
    code: string,
    message: string,
    hint?: string
  ): ValidationError {
    return {
      path: fieldName.split('.'),
      message,
      code,
      hint,
      severity: 'error',
      context: { fieldName }
    };
  }

  /**
   * Track validation performance for monitoring
   * 
   * Integrates with existing CompatibilityMonitor system when available
   * 
   * @param operation Name of the validation operation
   * @param startTime Start time of the operation
   * @param success Whether validation succeeded
   */
  private static trackValidationPerformance(
    operation: string,
    startTime: number,
    success: boolean
  ): void {
    const duration = performance.now() - startTime;

    // Integration with existing CompatibilityMonitor
    const globalObj = globalThis as Record<string, unknown>;
    const compatMonitor = globalObj.CompatibilityMonitor as {
      trackValidation?: (source: string, op: string, start: number, end: number, success: boolean) => void
    } | undefined;

    if (compatMonitor && typeof compatMonitor.trackValidation === 'function') {
      compatMonitor.trackValidation(
        'CommonValidators',
        operation,
        startTime,
        performance.now(),
        success
      );
    }

  }
}