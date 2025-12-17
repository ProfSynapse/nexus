/**
 * OperationValidator - Handles validation of batch content operations
 * Follows Single Responsibility Principle by focusing only on validation
 */

import { ContentOperation } from '../../../types';

export interface ValidationResult {
  success: boolean;
  error?: string;
}

/**
 * Service responsible for validating batch content operations
 * Follows SRP by focusing only on validation operations
 */
export class OperationValidator {
  /**
   * Validate an array of operations
   */
  validateOperations(operations: ContentOperation[]): ValidationResult {
    try {
      // Validate operations array
      if (!operations || !Array.isArray(operations) || operations.length === 0) {
        return {
          success: false,
          error: 'Operations array is empty or not provided'
        };
      }

      // Validate each operation
      for (let index = 0; index < operations.length; index++) {
        const operation = operations[index];
        const operationResult = this.validateSingleOperation(operation, index);
        
        if (!operationResult.success) {
          return operationResult;
        }
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `Validation failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Validate a single operation
   */
  private validateSingleOperation(operation: ContentOperation, index: number): ValidationResult {
    // Validate basic structure
    if (!operation.type) {
      return {
        success: false,
        error: `Missing 'type' property in operation at index ${index}`
      };
    }

    if (!operation.params) {
      return {
        success: false,
        error: `Missing 'params' property in operation at index ${index}`
      };
    }

    if (!operation.params.filePath) {
      return {
        success: false,
        error: `Missing 'filePath' property in operation at index ${index}. Each operation must include a 'filePath' parameter.`
      };
    }

    // Validate operation-specific parameters
    return this.validateOperationParams(operation, index);
  }

  /**
   * Validate operation-specific parameters
   */
  private validateOperationParams(operation: ContentOperation, index: number): ValidationResult {
    switch (operation.type) {
      case 'create':
      case 'append':
      case 'prepend':
        return this.validateContentOperation(operation, index);
      
      case 'replace':
        return this.validateReplaceOperation(operation, index);
      
      case 'replaceByLine':
        return this.validateReplaceByLineOperation(operation, index);
      
      case 'delete':
        return this.validateDeleteOperation(operation, index);
      
      case 'findReplace':
        return this.validateFindReplaceOperation(operation, index);
      
      case 'read':
        return this.validateReadOperation(operation, index);
      
      default:
        return {
          success: false,
          error: `Unknown operation type: ${(operation as unknown as { type: string }).type} at index ${index}`
        };
    }
  }

  /**
   * Validate content operations (create, append, prepend)
   */
  private validateContentOperation(operation: ContentOperation, index: number): ValidationResult {
    const params = operation.params as any;
    if (!params.content) {
      return {
        success: false,
        error: `Missing 'content' property in ${operation.type} operation at index ${index}`
      };
    }
    return { success: true };
  }

  /**
   * Validate replace operation
   */
  private validateReplaceOperation(operation: ContentOperation, index: number): ValidationResult {
    const params = operation.params as any;
    if (!params.oldContent) {
      return {
        success: false,
        error: `Missing 'oldContent' property in replace operation at index ${index}`
      };
    }

    if (!params.newContent) {
      return {
        success: false,
        error: `Missing 'newContent' property in replace operation at index ${index}`
      };
    }

    return { success: true };
  }

  /**
   * Validate replace by line operation
   */
  private validateReplaceByLineOperation(operation: ContentOperation, index: number): ValidationResult {
    const params = operation.params as any;
    if (typeof params.startLine !== 'number') {
      return {
        success: false,
        error: `Missing or invalid 'startLine' property in replaceByLine operation at index ${index}`
      };
    }

    if (typeof params.endLine !== 'number') {
      return {
        success: false,
        error: `Missing or invalid 'endLine' property in replaceByLine operation at index ${index}`
      };
    }

    if (!params.newContent) {
      return {
        success: false,
        error: `Missing 'newContent' property in replaceByLine operation at index ${index}`
      };
    }

    return { success: true };
  }

  /**
   * Validate delete operation
   */
  private validateDeleteOperation(operation: ContentOperation, index: number): ValidationResult {
    const params = operation.params as any;
    if (!params.content) {
      return {
        success: false,
        error: `Missing 'content' property in delete operation at index ${index}`
      };
    }
    return { success: true };
  }

  /**
   * Validate find and replace operation
   */
  private validateFindReplaceOperation(operation: ContentOperation, index: number): ValidationResult {
    const params = operation.params as any;
    if (!params.findText) {
      return {
        success: false,
        error: `Missing 'findText' property in findReplace operation at index ${index}`
      };
    }

    if (!params.replaceText) {
      return {
        success: false,
        error: `Missing 'replaceText' property in findReplace operation at index ${index}`
      };
    }

    return { success: true };
  }

  /**
   * Validate read operation
   */
  private validateReadOperation(operation: ContentOperation, index: number): ValidationResult {
    // Read operation only requires filePath, which is already validated
    return { success: true };
  }

  /**
   * Get validation statistics
   */
  getValidationStats(operations: ContentOperation[]): {
    totalOperations: number;
    operationTypes: Record<string, number>;
    hasValidationErrors: boolean;
  } {
    const stats = {
      totalOperations: operations.length,
      operationTypes: {} as Record<string, number>,
      hasValidationErrors: false
    };

    for (const operation of operations) {
      const type = operation.type || 'unknown';
      stats.operationTypes[type] = (stats.operationTypes[type] || 0) + 1;
    }

    const validationResult = this.validateOperations(operations);
    stats.hasValidationErrors = !validationResult.success;

    return stats;
  }
}