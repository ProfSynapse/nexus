/**
 * Pagination Types Export Barrel
 *
 * Location: src/types/pagination/index.ts
 * Purpose: Centralized export for pagination types
 */

export type {
  PaginationParams,
  PaginatedResult
} from './PaginationTypes';

export {
  createEmptyPaginatedResult,
  calculatePaginationMetadata
} from './PaginationTypes';
