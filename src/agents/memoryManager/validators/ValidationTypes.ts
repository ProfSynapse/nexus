/**
 * Location: /src/agents/memoryManager/validators/ValidationTypes.ts
 *
 * Purpose: Shared validation types and interfaces
 * Extracted from ValidationService.ts for reusability
 *
 * Used by: All validators
 * Dependencies: None
 */

/**
 * Validation error structure
 */
export interface ValidationError {
  field: string;
  value: unknown;
  requirement: string;
}
