/**
 * ResultGroupingHelper - Handles result grouping operations
 * Location: /src/agents/searchManager/services/formatters/ResultGroupingHelper.ts
 *
 * Provides grouping functionality for search results including primary grouping,
 * sub-grouping, and group statistics calculation.
 *
 * Used by: ResultFormatter for groupResults operations
 */

import {
  MemorySearchResult,
  MemoryGroupOption,
  GroupedMemoryResults,
  MemoryResultGroup,
  GroupStatistics,
  MemoryType
} from '../../../../types/memory/MemorySearchTypes';

/**
 * Helper class for result grouping operations
 */
export class ResultGroupingHelper {
  /**
   * Group results by specified criteria
   */
  async groupResults(results: MemorySearchResult[], groupBy: MemoryGroupOption): Promise<GroupedMemoryResults> {
    const groups = new Map<string, MemorySearchResult[]>();

    // Group results by primary criteria
    for (const result of results) {
      const groupKey = this.getGroupKey(result, groupBy.groupBy);
      const existingGroup = groups.get(groupKey) || [];
      existingGroup.push(result);
      groups.set(groupKey, existingGroup);
    }

    // Apply sub-grouping if specified
    if (groupBy.subGroupBy) {
      const subGroupedResults = new Map<string, MemorySearchResult[]>();

      groups.forEach((groupResults, primaryKey) => {
        const subGroups = new Map<string, MemorySearchResult[]>();

        for (const result of groupResults) {
          const subGroupKey = this.getGroupKey(result, groupBy.subGroupBy!);
          const combinedKey = `${primaryKey}:${subGroupKey}`;
          const existingSubGroup = subGroups.get(combinedKey) || [];
          existingSubGroup.push(result);
          subGroups.set(combinedKey, existingSubGroup);
        }

        subGroups.forEach((subResults, subKey) => {
          subGroupedResults.set(subKey, subResults);
        });
      });

      // Replace groups with sub-grouped results
      groups.clear();
      subGroupedResults.forEach((results, key) => {
        groups.set(key, results);
      });
    }

    // Convert to result format
    const resultGroups: MemoryResultGroup[] = [];
    groups.forEach((results, key) => {
      const totalScore = results.reduce((sum, r) => sum + r.score, 0);
      const averageScore = results.length > 0 ? totalScore / results.length : 0;

      resultGroups.push({
        key,
        displayName: this.getDisplayName(key, groupBy),
        results,
        count: results.length,
        totalScore,
        averageScore,
        metadata: this.buildGroupMetadata(results, key)
      });
    });

    // Sort groups by count (descending)
    resultGroups.sort((a, b) => b.count - a.count);

    // Calculate group statistics
    const groupStats = this.calculateGroupStatistics(resultGroups);

    return {
      groups: resultGroups,
      totalGroups: resultGroups.length,
      totalResults: results.length,
      groupedBy: groupBy,
      groupStats
    };
  }

  /**
   * Get group key for a result based on grouping criteria
   */
  private getGroupKey(result: MemorySearchResult, groupBy: string): string {
    switch (groupBy) {
      case 'type':
        return result.type;

      case 'session':
        return result.metadata.sessionId || 'No Session';

      case 'workspace':
        return result.metadata.workspaceId || 'No Workspace';

      case 'date':
        try {
          const date = new Date(result.metadata.created);
          return date.toISOString().split('T')[0]; // YYYY-MM-DD
        } catch {
          return 'Unknown Date';
        }

      case 'agent':
        return result.metadata.agent || 'No Agent';

      case 'mode':
        return result.metadata.mode || 'No Mode';

      case 'success':
        if (result.type === MemoryType.TOOL_CALL && result.metadata.success !== undefined) {
          return result.metadata.success ? 'Success' : 'Failed';
        }
        return 'N/A';

      default:
        return 'Other';
    }
  }

  /**
   * Get display name for a group
   */
  private getDisplayName(key: string, groupBy: MemoryGroupOption): string {
    // Handle sub-grouped keys
    if (key.includes(':')) {
      const [primary, secondary] = key.split(':');
      return `${primary} → ${secondary}`;
    }

    return key;
  }

  /**
   * Build metadata for a group
   */
  private buildGroupMetadata(results: MemorySearchResult[], key: string): Record<string, any> {
    const metadata: Record<string, any> = {};

    // Calculate group-specific statistics
    const scores = results.map(r => r.score);
    metadata.minScore = Math.min(...scores);
    metadata.maxScore = Math.max(...scores);
    metadata.scoreStdDev = this.calculateStandardDeviation(scores);

    // Type distribution within group
    const typeDistribution: Record<string, number> = {};
    for (const result of results) {
      typeDistribution[result.type] = (typeDistribution[result.type] || 0) + 1;
    }
    metadata.typeDistribution = typeDistribution;

    // Date range within group
    const timestamps = results.map(r => new Date(r.metadata.created).getTime()).filter(t => !isNaN(t));
    if (timestamps.length > 0) {
      metadata.dateRange = {
        start: new Date(Math.min(...timestamps)).toISOString(),
        end: new Date(Math.max(...timestamps)).toISOString()
      };
    }

    return metadata;
  }

  /**
   * Calculate statistics across all groups
   */
  private calculateGroupStatistics(groups: MemoryResultGroup[]): GroupStatistics {
    if (groups.length === 0) {
      return {
        averageGroupSize: 0,
        largestGroupSize: 0,
        smallestGroupSize: 0,
        scoreDistribution: {}
      };
    }

    const groupSizes = groups.map(g => g.count);
    const averageGroupSize = groupSizes.reduce((sum, size) => sum + size, 0) / groups.length;
    const largestGroupSize = Math.max(...groupSizes);
    const smallestGroupSize = Math.min(...groupSizes);

    // Score distribution across all groups
    const scoreDistribution: Record<string, number> = {};
    for (const group of groups) {
      const scoreRange = this.getScoreRange(group.averageScore);
      scoreDistribution[scoreRange] = (scoreDistribution[scoreRange] || 0) + 1;
    }

    return {
      averageGroupSize: Math.round(averageGroupSize * 100) / 100,
      largestGroupSize,
      smallestGroupSize,
      scoreDistribution
    };
  }

  /**
   * Get score range for a score value
   */
  private getScoreRange(score: number): string {
    if (score >= 0.9) return '0.9-1.0';
    if (score >= 0.8) return '0.8-0.9';
    if (score >= 0.7) return '0.7-0.8';
    if (score >= 0.6) return '0.6-0.7';
    if (score >= 0.5) return '0.5-0.6';
    return '0.0-0.5';
  }

  /**
   * Calculate standard deviation of values
   */
  private calculateStandardDeviation(values: number[]): number {
    if (values.length === 0) return 0;

    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length;

    return Math.sqrt(avgSquaredDiff);
  }
}
