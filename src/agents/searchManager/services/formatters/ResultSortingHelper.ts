/**
 * ResultSortingHelper - Handles result sorting operations
 * Location: /src/agents/searchManager/services/formatters/ResultSortingHelper.ts
 *
 * Provides sorting functionality for search results including score-based,
 * timestamp-based, and relevance-based sorting.
 *
 * Used by: ResultFormatter for sortResults operations
 */

import {
  MemorySearchResult,
  MemorySortOption,
  MemoryType
} from '../../../../types/memory/MemorySearchTypes';

/**
 * Helper class for result sorting operations
 */
export class ResultSortingHelper {
  /**
   * Sort results by specified criteria
   */
  sortResults(results: MemorySearchResult[], sortBy: MemorySortOption): MemorySearchResult[] {
    return [...results].sort((a, b) => {
      let comparison = 0;

      switch (sortBy.field) {
        case 'score':
          comparison = b.score - a.score;
          break;

        case 'timestamp':
          const aTime = new Date(a.metadata.created).getTime();
          const bTime = new Date(b.metadata.created).getTime();
          comparison = bTime - aTime;
          break;

        case 'relevance':
          comparison = this.compareRelevance(a, b);
          break;

        default:
          comparison = 0;
      }

      return sortBy.direction === 'asc' ? -comparison : comparison;
    });
  }

  /**
   * Compare relevance between two results
   * Uses custom logic to boost certain types and recent results
   */
  private compareRelevance(a: MemorySearchResult, b: MemorySearchResult): number {
    let aRelevance = a.score;
    let bRelevance = b.score;

    // Boost tool call results
    if (a.type === MemoryType.TOOL_CALL) aRelevance += 0.1;
    if (b.type === MemoryType.TOOL_CALL) bRelevance += 0.1;

    // Boost recent results
    const aTime = new Date(a.metadata.created).getTime();
    const bTime = new Date(b.metadata.created).getTime();
    const timeDiff = Math.abs(aTime - bTime);
    const daysDiff = timeDiff / (1000 * 60 * 60 * 24);

    if (daysDiff < 1) {
      if (aTime > bTime) aRelevance += 0.05;
      else bRelevance += 0.05;
    }

    return bRelevance - aRelevance;
  }
}
