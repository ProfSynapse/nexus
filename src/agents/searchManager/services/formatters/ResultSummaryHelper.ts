/**
 * ResultSummaryHelper - Handles result summary generation
 * Location: /src/agents/searchManager/services/formatters/ResultSummaryHelper.ts
 *
 * Provides summary building functionality including statistics calculation,
 * type distribution, and date range analysis.
 *
 * Used by: ResultFormatter for buildSummary operations
 */

import {
  MemorySearchResult,
  MemoryResultSummary
} from '../../../../types/memory/MemorySearchTypes';

/**
 * Helper class for result summary generation
 */
export class ResultSummaryHelper {
  /**
   * Build result summary statistics
   */
  async buildSummary(results: MemorySearchResult[]): Promise<MemoryResultSummary> {
    const totalResults = results.length;
    const totalScore = results.reduce((sum, r) => sum + r.score, 0);
    const averageScore = totalResults > 0 ? totalScore / totalResults : 0;

    // Calculate type distribution
    const typeDistribution: Record<string, number> = {};
    let oldestTimestamp = new Date();
    let newestTimestamp = new Date(0);

    for (const result of results) {
      // Type distribution
      const type = result.type;
      typeDistribution[type] = (typeDistribution[type] || 0) + 1;

      // Date range
      try {
        const timestamp = new Date(result.metadata.created);
        if (timestamp < oldestTimestamp) {
          oldestTimestamp = timestamp;
        }
        if (timestamp > newestTimestamp) {
          newestTimestamp = timestamp;
        }
      } catch (error) {
        // Ignore invalid dates
      }
    }

    return {
      totalResults,
      averageScore: Math.round(averageScore * 1000) / 1000,
      typeDistribution,
      dateRange: {
        start: totalResults > 0 ? oldestTimestamp : new Date(),
        end: totalResults > 0 ? newestTimestamp : new Date()
      },
      executionTime: 0 // Set by caller
    };
  }
}
