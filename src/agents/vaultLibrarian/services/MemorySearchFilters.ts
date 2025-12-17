/**
 * Memory Search Filters
 * 
 * Location: src/agents/vaultLibrarian/services/MemorySearchFilters.ts
 * Purpose: Tool call filtering, date ranges, session filtering logic
 * Used by: SearchMemoryMode for applying various filters to search results
 */

import {
  MemorySearchResult,
  MemoryFilterOptions,
  DateRange,
  ToolCallFilter,
  ContentFilterOptions,
  MemoryFilterConfiguration,
  MemoryType
} from '../../../types/memory/MemorySearchTypes';

export interface MemorySearchFiltersInterface {
  filter(results: MemorySearchResult[], options: MemoryFilterOptions): MemorySearchResult[];
  applyDateFilter(results: MemorySearchResult[], dateRange: DateRange): MemorySearchResult[];
  applyContentFilter(results: MemorySearchResult[], pattern: string, options?: ContentFilterOptions): MemorySearchResult[];
  applyToolCallFilter(results: MemorySearchResult[], filter: ToolCallFilter): MemorySearchResult[];
  applyScoreFilter(results: MemorySearchResult[], threshold: number): MemorySearchResult[];
  applySessionFilter(results: MemorySearchResult[], sessionIds: string[]): MemorySearchResult[];
  applyWorkspaceFilter(results: MemorySearchResult[], workspaceIds: string[]): MemorySearchResult[];
  getConfiguration(): MemoryFilterConfiguration;
  updateConfiguration(config: Partial<MemoryFilterConfiguration>): void;
}

export class MemorySearchFilters implements MemorySearchFiltersInterface {
  private configuration: MemoryFilterConfiguration;

  constructor(config?: Partial<MemoryFilterConfiguration>) {
    this.configuration = {
      enableDateFiltering: true,
      enableSessionFiltering: true,
      enableToolCallFiltering: true,
      defaultDateRange: null,
      strictFiltering: false,
      ...config
    };
  }

  /**
   * Apply all configured filters to results
   */
  filter(results: MemorySearchResult[], options: MemoryFilterOptions): MemorySearchResult[] {
    let filtered = results;

    // Apply date filter
    if (this.configuration.enableDateFiltering && options.dateRange) {
      filtered = this.applyDateFilter(filtered, options.dateRange);
    }

    // Apply session filter
    if (this.configuration.enableSessionFiltering && options.filterBySession && options.sessionId) {
      filtered = this.applySessionFilter(filtered, [options.sessionId]);
    }

    // Apply workspace filter
    if (options.workspaceId) {
      filtered = this.applyWorkspaceFilter(filtered, [options.workspaceId]);
    }

    // Apply tool call filters
    if (this.configuration.enableToolCallFiltering && options.toolCallFilters) {
      filtered = this.applyToolCallFilter(filtered, options.toolCallFilters);
    }

    return filtered;
  }

  /**
   * Apply date range filter
   */
  applyDateFilter(results: MemorySearchResult[], dateRange: DateRange): MemorySearchResult[] {
    if (!dateRange) return results;

    const startTime = dateRange.start ? new Date(dateRange.start).getTime() : 0;
    const endTime = dateRange.end ? new Date(dateRange.end).getTime() : Date.now();

    return results.filter(result => {
      try {
        const resultTime = new Date(result.metadata.created).getTime();
        return resultTime >= startTime && resultTime <= endTime;
      } catch (error) {
        // If date parsing fails, include result unless strict filtering is enabled
        return !this.configuration.strictFiltering;
      }
    });
  }

  /**
   * Apply content pattern filter
   */
  applyContentFilter(
    results: MemorySearchResult[], 
    pattern: string, 
    options: ContentFilterOptions = {}
  ): MemorySearchResult[] {
    if (!pattern) return results;

    try {
      const regex = options.regex ? 
        new RegExp(pattern, options.caseSensitive ? 'g' : 'gi') :
        null;
      
      const searchPattern = options.caseSensitive ? pattern : pattern.toLowerCase();

      return results.filter(result => {
        const searchableContent = this.getSearchableContent(result, options.caseSensitive);
        
        if (regex) {
          return regex.test(searchableContent);
        }
        
        if (options.wholeWord) {
          const wordBoundaryPattern = new RegExp(`\\b${this.escapeRegex(searchPattern)}\\b`, 
            options.caseSensitive ? 'g' : 'gi');
          return wordBoundaryPattern.test(searchableContent);
        }
        
        return searchableContent.includes(searchPattern);
      });
    } catch (error) {
      return this.configuration.strictFiltering ? [] : results;
    }
  }

  /**
   * Apply tool call filter
   */
  applyToolCallFilter(results: MemorySearchResult[], filter: ToolCallFilter): MemorySearchResult[] {
    return results.filter(result => {
      // Only apply to tool call results
      if (result.type !== MemoryType.TOOL_CALL) return true;

      return this.matchesToolCallFilter(result, filter);
    });
  }

  /**
   * Apply score threshold filter
   */
  applyScoreFilter(results: MemorySearchResult[], threshold: number): MemorySearchResult[] {
    if (threshold <= 0) return results;
    
    return results.filter(result => result.score >= threshold);
  }

  /**
   * Apply session filter
   */
  applySessionFilter(results: MemorySearchResult[], sessionIds: string[]): MemorySearchResult[] {
    if (!sessionIds || sessionIds.length === 0) return results;

    return results.filter(result => {
      const resultSessionId = result.metadata.sessionId;
      return resultSessionId && sessionIds.includes(resultSessionId);
    });
  }

  /**
   * Apply workspace filter
   */
  applyWorkspaceFilter(results: MemorySearchResult[], workspaceIds: string[]): MemorySearchResult[] {
    if (!workspaceIds || workspaceIds.length === 0) return results;

    return results.filter(result => {
      const resultWorkspaceId = result.metadata.workspaceId;
      return resultWorkspaceId && workspaceIds.includes(resultWorkspaceId);
    });
  }

  /**
   * Apply type filter
   */
  applyTypeFilter(results: MemorySearchResult[], types: MemoryType[]): MemorySearchResult[] {
    if (!types || types.length === 0) return results;

    return results.filter(result => types.includes(result.type as MemoryType));
  }

  /**
   * Apply metadata type filter
   */
  applyMetadataTypeFilter(results: MemorySearchResult[], types: string[]): MemorySearchResult[] {
    if (!types || types.length === 0) return results;

    return results.filter(result => {
      const type = result.metadata.type;
      return type && types.includes(type);
    });
  }

  /**
   * Apply success status filter
   */
  applySuccessFilter(results: MemorySearchResult[], successStatus: boolean): MemorySearchResult[] {
    return results.filter(result => {
      // Only apply to tool call results
      if (result.type !== MemoryType.TOOL_CALL) return true;

      return result.metadata.success === successStatus;
    });
  }

  /**
   * Apply execution time range filter
   */
  applyExecutionTimeFilter(
    results: MemorySearchResult[], 
    minTime?: number, 
    maxTime?: number
  ): MemorySearchResult[] {
    if (minTime === undefined && maxTime === undefined) return results;

    return results.filter(result => {
      // Only apply to tool call results
      if (result.type !== MemoryType.TOOL_CALL) return true;

      const executionTime = result.metadata.executionTime;
      if (executionTime === undefined) return !this.configuration.strictFiltering;

      if (minTime !== undefined && executionTime < minTime) return false;
      if (maxTime !== undefined && executionTime > maxTime) return false;

      return true;
    });
  }

  /**
   * Apply composite filter with multiple criteria
   */
  applyCompositeFilter(
    results: MemorySearchResult[],
    filters: {
      dateRange?: DateRange;
      sessionIds?: string[];
      workspaceIds?: string[];
      types?: MemoryType[];
      metadataTypes?: string[];
      scoreThreshold?: number;
      successStatus?: boolean;
      minExecutionTime?: number;
      maxExecutionTime?: number;
      contentPattern?: string;
      contentOptions?: ContentFilterOptions;
    }
  ): MemorySearchResult[] {
    let filtered = results;

    // Apply each filter in order
    if (filters.dateRange) {
      filtered = this.applyDateFilter(filtered, filters.dateRange);
    }

    if (filters.sessionIds) {
      filtered = this.applySessionFilter(filtered, filters.sessionIds);
    }

    if (filters.workspaceIds) {
      filtered = this.applyWorkspaceFilter(filtered, filters.workspaceIds);
    }

    if (filters.types) {
      filtered = this.applyTypeFilter(filtered, filters.types);
    }

    if (filters.metadataTypes) {
      filtered = this.applyMetadataTypeFilter(filtered, filters.metadataTypes);
    }

    if (filters.scoreThreshold !== undefined) {
      filtered = this.applyScoreFilter(filtered, filters.scoreThreshold);
    }

    if (filters.successStatus !== undefined) {
      filtered = this.applySuccessFilter(filtered, filters.successStatus);
    }

    if (filters.minExecutionTime !== undefined || filters.maxExecutionTime !== undefined) {
      filtered = this.applyExecutionTimeFilter(filtered, filters.minExecutionTime, filters.maxExecutionTime);
    }

    if (filters.contentPattern) {
      filtered = this.applyContentFilter(filtered, filters.contentPattern, filters.contentOptions);
    }

    return filtered;
  }

  /**
   * Get current configuration
   */
  getConfiguration(): MemoryFilterConfiguration {
    return { ...this.configuration };
  }

  /**
   * Update configuration
   */
  updateConfiguration(config: Partial<MemoryFilterConfiguration>): void {
    this.configuration = { ...this.configuration, ...config };
  }

  // Private helper methods

  private matchesToolCallFilter(result: MemorySearchResult, filter: ToolCallFilter): boolean {
    const metadata = result.metadata;

    // Agent filter
    if (filter.agent && metadata.agent !== filter.agent) {
      return false;
    }

    // Mode filter
    if (filter.mode && metadata.mode !== filter.mode) {
      return false;
    }

    // Success filter
    if (filter.success !== undefined && metadata.success !== filter.success) {
      return false;
    }

    // Execution time filters
    const executionTime = metadata.executionTime;
    if (executionTime !== undefined) {
      if (filter.minExecutionTime !== undefined && executionTime < filter.minExecutionTime) {
        return false;
      }
      if (filter.maxExecutionTime !== undefined && executionTime > filter.maxExecutionTime) {
        return false;
      }
    } else if (this.configuration.strictFiltering && 
               (filter.minExecutionTime !== undefined || filter.maxExecutionTime !== undefined)) {
      // In strict mode, reject results without execution time if time filters are specified
      return false;
    }

    return true;
  }

  private getSearchableContent(result: MemorySearchResult, caseSensitive: boolean = false): string {
    const parts = [
      result.highlight,
      result.context.before,
      result.context.match,
      result.context.after,
      JSON.stringify(result.metadata)
    ];

    const content = parts.join(' ');
    return caseSensitive ? content : content.toLowerCase();
  }

  private escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Get filter statistics
   */
  getFilterStats(originalResults: MemorySearchResult[], filteredResults: MemorySearchResult[]): {
    originalCount: number;
    filteredCount: number;
    removedCount: number;
    filterEfficiency: number;
    typeDistribution: Record<string, number>;
  } {
    const originalCount = originalResults.length;
    const filteredCount = filteredResults.length;
    const removedCount = originalCount - filteredCount;
    const filterEfficiency = originalCount > 0 ? (removedCount / originalCount) * 100 : 0;

    // Calculate type distribution of filtered results
    const typeDistribution: Record<string, number> = {};
    for (const result of filteredResults) {
      const type = result.type;
      typeDistribution[type] = (typeDistribution[type] || 0) + 1;
    }

    return {
      originalCount,
      filteredCount,
      removedCount,
      filterEfficiency: Math.round(filterEfficiency * 100) / 100,
      typeDistribution
    };
  }

  /**
   * Validate filter configuration
   */
  validateFilters(filters: MemoryFilterOptions): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate date range
    if (filters.dateRange) {
      if (filters.dateRange.start && filters.dateRange.end) {
        const startDate = new Date(filters.dateRange.start);
        const endDate = new Date(filters.dateRange.end);

        if (isNaN(startDate.getTime())) {
          errors.push('Invalid start date format');
        }
        if (isNaN(endDate.getTime())) {
          errors.push('Invalid end date format');
        }
        if (startDate > endDate) {
          errors.push('Start date must be before end date');
        }
      }
    }

    // Validate tool call filters
    if (filters.toolCallFilters) {
      const tcf = filters.toolCallFilters;
      if (tcf.minExecutionTime !== undefined && tcf.minExecutionTime < 0) {
        errors.push('Minimum execution time must be non-negative');
      }
      if (tcf.maxExecutionTime !== undefined && tcf.maxExecutionTime < 0) {
        errors.push('Maximum execution time must be non-negative');
      }
      if (tcf.minExecutionTime !== undefined && 
          tcf.maxExecutionTime !== undefined && 
          tcf.minExecutionTime > tcf.maxExecutionTime) {
        errors.push('Minimum execution time must be less than maximum execution time');
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Create optimized filter chain for performance
   */
  createFilterChain(options: MemoryFilterOptions): ((results: MemorySearchResult[]) => MemorySearchResult[])[] {
    const chain: ((results: MemorySearchResult[]) => MemorySearchResult[])[] = [];

    // Add filters in order of selectivity (most selective first)
    
    // Session filter (very selective)
    if (options.filterBySession && options.sessionId) {
      chain.push((results) => this.applySessionFilter(results, [options.sessionId!]));
    }

    // Workspace filter (selective)
    if (options.workspaceId) {
      chain.push((results) => this.applyWorkspaceFilter(results, [options.workspaceId!]));
    }

    // Tool call filters (moderately selective)
    if (options.toolCallFilters) {
      const filters = options.toolCallFilters;
      chain.push((results) => this.applyToolCallFilter(results, filters));
    }

    // Date filter (less selective)
    if (options.dateRange) {
      const dateRange = options.dateRange;
      chain.push((results) => this.applyDateFilter(results, dateRange));
    }

    return chain;
  }

  /**
   * Apply filter chain efficiently
   */
  applyFilterChain(
    results: MemorySearchResult[], 
    chain: ((results: MemorySearchResult[]) => MemorySearchResult[])[]
  ): MemorySearchResult[] {
    return chain.reduce((currentResults, filter) => {
      if (currentResults.length === 0) return currentResults; // Short-circuit if no results left
      return filter(currentResults);
    }, results);
  }
}