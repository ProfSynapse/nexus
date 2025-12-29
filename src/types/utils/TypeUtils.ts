/**
 * Location: src/types/utils/TypeUtils.ts
 *
 * Type Utility Functions
 * Safe type guards and extraction helpers
 *
 * Relationships:
 * - Used by: All services for safe type narrowing and validation
 * - Used by: Adapters for parsing API responses
 * - Used by: Error handling utilities
 */

/**
 * Check if value is a non-null object (not array)
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check if object has a specific property
 */
export function hasProperty<K extends string>(
  obj: unknown,
  key: K
): obj is Record<K, unknown> {
  return isObject(obj) && key in obj;
}

/**
 * Check if object has multiple properties
 */
export function hasProperties<K extends string>(
  obj: unknown,
  keys: K[]
): obj is Record<K, unknown> {
  return isObject(obj) && keys.every(key => key in obj);
}

/**
 * Safely get a string property
 */
export function getString(obj: unknown, key: string): string | undefined {
  if (hasProperty(obj, key) && typeof obj[key] === 'string') {
    return obj[key] as string;
  }
  return undefined;
}

/**
 * Safely get a number property
 */
export function getNumber(obj: unknown, key: string): number | undefined {
  if (hasProperty(obj, key) && typeof obj[key] === 'number') {
    return obj[key] as number;
  }
  return undefined;
}

/**
 * Safely get a boolean property
 */
export function getBoolean(obj: unknown, key: string): boolean | undefined {
  if (hasProperty(obj, key) && typeof obj[key] === 'boolean') {
    return obj[key] as boolean;
  }
  return undefined;
}

/**
 * Safely get an array property
 */
export function getArray<T = unknown>(obj: unknown, key: string): T[] | undefined {
  if (hasProperty(obj, key) && Array.isArray(obj[key])) {
    return obj[key] as T[];
  }
  return undefined;
}

/**
 * Safely get a nested object property
 */
export function getObject(obj: unknown, key: string): Record<string, unknown> | undefined {
  if (hasProperty(obj, key) && isObject(obj[key])) {
    return obj[key] as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Type-safe error message extraction
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (isObject(error) && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

/**
 * Type-safe error stack extraction
 */
export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }
  return undefined;
}

/**
 * Assert value is defined (non-null, non-undefined)
 */
export function assertDefined<T>(value: T | null | undefined, message?: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message ?? 'Expected value to be defined');
  }
}

/**
 * Narrow unknown to specific type with validation
 */
export function narrowTo<T>(
  value: unknown,
  validator: (v: unknown) => v is T,
  fallback: T
): T {
  return validator(value) ? value : fallback;
}
