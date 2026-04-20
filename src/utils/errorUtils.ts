import { safeStringify } from './jsonUtils';

/**
 * Utility functions for error handling
 */

/**
 * Extracts a readable message from any error type
 * @param error Any error type (Error, string, unknown, etc.)
 * @returns A string message representing the error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  } else if (typeof error === 'string') {
    return error;
  } else if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  } else if (error === null) {
    return 'Null error';
  } else if (error === undefined) {
    return 'Undefined error';
  }

  if (typeof error === 'object') {
    return safeStringify(error);
  }

  if (typeof error === 'function') {
    return error.name ? `[Function ${error.name}]` : '[Function]';
  }

  if (typeof error === 'symbol') {
    return error.description ?? error.toString();
  }

  if (typeof error === 'number' || typeof error === 'bigint' || typeof error === 'boolean') {
    return `${error}`;
  }

  return 'Unknown error';
}

/**
 * Creates a prefixed error message from any error type
 * @param prefix The prefix to add to the error message (e.g. "Failed to create folder: ")
 * @param error Any error type (Error, string, unknown, etc.)
 * @returns A string message with the prefix and the error
 */
export function createErrorMessage(prefix: string, error: unknown): string {
  return `${prefix}${getErrorMessage(error)}`;
}
