/**
 * ResultHighlightHelper - Handles result highlighting operations
 * Location: /src/agents/searchManager/services/formatters/ResultHighlightHelper.ts
 *
 * Provides highlighting functionality for search results including
 * multi-field search and context extraction.
 *
 * Used by: ResultFormatter for addHighlights operations
 */

import {
  MemorySearchResult,
  SearchHighlight,
  HighlightOptions
} from '../../../../types/memory/MemorySearchTypes';

/**
 * Helper class for result highlighting operations
 */
export class ResultHighlightHelper {
  private maxHighlightLength: number;

  constructor(maxHighlightLength: number = 200) {
    this.maxHighlightLength = maxHighlightLength;
  }

  /**
   * Add highlights to results
   */
  async addHighlights(
    results: MemorySearchResult[],
    query: string,
    options: HighlightOptions = {}
  ): Promise<MemorySearchResult[]> {
    const {
      maxHighlights = 3,
      highlightLength = this.maxHighlightLength,
      caseSensitive = false,
      wholeWord = false
    } = options;

    return results.map(result => {
      const highlights = this.generateHighlights(result, query, {
        maxHighlights,
        highlightLength,
        caseSensitive,
        wholeWord
      });

      return {
        ...result,
        highlights
      } as MemorySearchResult & { highlights: SearchHighlight[] };
    });
  }

  /**
   * Generate highlights for a single result
   */
  private generateHighlights(
    result: MemorySearchResult,
    query: string,
    options: { maxHighlights: number; highlightLength: number; caseSensitive: boolean; wholeWord: boolean }
  ): SearchHighlight[] {
    const highlights: SearchHighlight[] = [];
    const searchQuery = options.caseSensitive ? query : query.toLowerCase();

    // Search in different fields
    const searchFields = [
      { field: 'highlight', content: result.highlight },
      { field: 'context.match', content: result.context.match },
      { field: 'context.before', content: result.context.before },
      { field: 'context.after', content: result.context.after }
    ];

    for (const { field, content } of searchFields) {
      if (highlights.length >= options.maxHighlights) break;

      const searchContent = options.caseSensitive ? content : content.toLowerCase();
      let index = searchContent.indexOf(searchQuery);

      while (index !== -1 && highlights.length < options.maxHighlights) {
        const start = Math.max(0, index - 20);
        const end = Math.min(content.length, index + searchQuery.length + 20);

        highlights.push({
          field,
          start: index,
          end: index + searchQuery.length,
          text: content.substring(index, index + searchQuery.length),
          context: content.substring(start, end)
        });

        index = searchContent.indexOf(searchQuery, index + 1);
      }
    }

    return highlights.slice(0, options.maxHighlights);
  }
}
