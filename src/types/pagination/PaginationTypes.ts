/**
 * Pagination Types
 *
 * Location: src/types/pagination/PaginationTypes.ts
 * Purpose: Common pagination types used throughout the application
 * Used by: Storage adapters, API services, UI components
 *
 * Provides standardized pagination interfaces for consistent data fetching
 * across different storage backends (SQLite, JSONL, in-memory).
 */

/**
 * Pagination parameters for requesting paginated data
 *
 * @property page - The page number (0-indexed)
 * @property pageSize - Number of items per page
 * @property cursor - Optional cursor for cursor-based pagination
 */
export interface PaginationParams {
  /** Page number (0-indexed) */
  page?: number;

  /** Number of items per page */
  pageSize?: number;

  /** Optional cursor for cursor-based pagination */
  cursor?: string;
}

/**
 * Paginated result containing items and metadata
 *
 * @template T - The type of items in the result
 */
export interface PaginatedResult<T> {
  /** Array of items for the current page */
  items: T[];

  /** Current page number (0-indexed) */
  page: number;

  /** Number of items per page */
  pageSize: number;

  /** Total number of items across all pages */
  totalItems: number;

  /** Total number of pages */
  totalPages: number;

  /** Whether there is a next page available */
  hasNextPage: boolean;

  /** Whether there is a previous page available */
  hasPreviousPage: boolean;

  /** Optional cursor for the next page (cursor-based pagination) */
  nextCursor?: string;

  /** Optional cursor for the previous page (cursor-based pagination) */
  previousCursor?: string;
}

/**
 * Helper to create an empty paginated result
 */
export function createEmptyPaginatedResult<T>(
  page: number = 0,
  pageSize: number = 10
): PaginatedResult<T> {
  return {
    items: [],
    page,
    pageSize,
    totalItems: 0,
    totalPages: 0,
    hasNextPage: false,
    hasPreviousPage: false
  };
}

/**
 * Helper to calculate pagination metadata
 */
export function calculatePaginationMetadata(
  page: number,
  pageSize: number,
  totalItems: number
): Omit<PaginatedResult<unknown>, 'items'> {
  const totalPages = Math.ceil(totalItems / pageSize);

  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages - 1,
    hasPreviousPage: page > 0
  };
}

/**
 * Type guard to check if a value is a PaginatedResult
 */
export function isPaginatedResult<T>(
  value: T[] | PaginatedResult<T>
): value is PaginatedResult<T> {
  return value !== null &&
    typeof value === 'object' &&
    'items' in value &&
    'page' in value &&
    Array.isArray(value.items);
}

/**
 * Helper to normalize a union type result to an array
 * Extracts .items from PaginatedResult or returns array as-is
 *
 * @param result - Either an array or a PaginatedResult
 * @returns The items as an array
 */
export function normalizeToArray<T>(result: T[] | PaginatedResult<T>): T[] {
  if (isPaginatedResult(result)) {
    return result.items;
  }
  return result;
}

/**
 * Helper to get total count from a union type result
 * Returns totalItems from PaginatedResult or array length
 *
 * @param result - Either an array or a PaginatedResult
 * @returns The total count
 */
export function getTotalCount<T>(result: T[] | PaginatedResult<T>): number {
  if (isPaginatedResult(result)) {
    return result.totalItems;
  }
  return result.length;
}
