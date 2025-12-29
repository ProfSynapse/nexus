/**
 * Location: /src/agents/searchManager/services/FuzzySearchEngine.ts
 * Purpose: Performs fuzzy search operations on files and folders
 *
 * This service handles fuzzy matching logic for file and folder searches,
 * scoring results based on name and path matches.
 *
 * Used by: SearchDirectoryMode for fuzzy search operations
 * Integrates with: Obsidian fuzzy search API
 *
 * Responsibilities:
 * - Perform fuzzy searches on file/folder names and paths
 * - Calculate relevance scores for matches
 * - Return scored search results
 */

import { TFile, TFolder, prepareFuzzySearch } from 'obsidian';

/**
 * Search match result with scoring
 */
export interface FuzzyMatch {
  item: TFile | TFolder;
  score: number;
  matchType: string;
}

/**
 * Service for fuzzy search operations
 * Implements Single Responsibility Principle - only handles fuzzy searching
 */
export class FuzzySearchEngine {
  /**
   * Perform fuzzy search on items
   * @param items Items to search through
   * @param query Search query
   * @returns Array of matches with scores
   */
  performFuzzySearch(
    items: (TFile | TFolder)[],
    query: string
  ): FuzzyMatch[] {
    const fuzzySearch = prepareFuzzySearch(query);
    const matches: FuzzyMatch[] = [];

    for (const item of items) {
      let bestScore = 0;
      let bestMatchType = '';

      // Get appropriate name for search
      const itemName = item instanceof TFile ? item.basename : item.name;

      // Search by name
      const nameResult = fuzzySearch(itemName);
      if (nameResult) {
        const normalizedScore = Math.max(0, Math.min(1, 1 + (nameResult.score / 100)));
        if (normalizedScore > bestScore) {
          bestScore = normalizedScore;
          bestMatchType = 'name';
        }
      }

      // Search by full path
      const pathResult = fuzzySearch(item.path);
      if (pathResult) {
        const normalizedScore = Math.max(0, Math.min(1, 1 + (pathResult.score / 100))) * 0.8; // Lower weight for path matches
        if (normalizedScore > bestScore) {
          bestScore = normalizedScore;
          bestMatchType = 'path';
        }
      }

      // Include item if it has any match
      if (bestScore > 0) {
        matches.push({ item, score: bestScore, matchType: bestMatchType });
      }
    }

    return matches;
  }
}
