/**
 * Location: /src/agents/searchManager/services/SearchFilterApplicator.ts
 * Purpose: Applies filters to search results
 *
 * This service handles applying various filters to search candidates
 * including file type, depth, pattern, and date range filters.
 *
 * Used by: SearchDirectoryMode for filtering search candidates
 * Integrates with: Obsidian file system API
 *
 * Responsibilities:
 * - Apply file type filters
 * - Apply depth filters
 * - Apply regex pattern filters
 * - Apply date range filters
 */

import { TFile, TFolder } from 'obsidian';

/**
 * Filter parameters for search operations
 */
export interface SearchFilters {
  fileTypes?: string[];
  depth?: number;
  pattern?: string;
  dateRange?: {
    start?: string;
    end?: string;
  };
}

/**
 * Service for applying search filters
 * Implements Single Responsibility Principle - only handles filtering
 */
export class SearchFilterApplicator {
  /**
   * Apply all filters to items
   * @param items Items to filter
   * @param filters Filter parameters
   * @returns Filtered items
   */
  applyFilters(
    items: (TFile | TFolder)[],
    filters: SearchFilters
  ): (TFile | TFolder)[] {
    let filtered = items;

    // Apply each filter in sequence
    if (filters.fileTypes && filters.fileTypes.length > 0) {
      filtered = this.applyFileTypeFilter(filtered, filters.fileTypes);
    }

    if (filters.depth !== undefined) {
      filtered = this.applyDepthFilter(filtered, filters.depth);
    }

    if (filters.pattern) {
      filtered = this.applyPatternFilter(filtered, filters.pattern);
    }

    if (filters.dateRange) {
      filtered = this.applyDateRangeFilter(filtered, filters.dateRange);
    }

    return filtered;
  }

  /**
   * Apply file type filter
   * @param items Items to filter
   * @param fileTypes Allowed file types
   * @returns Filtered items
   */
  private applyFileTypeFilter(
    items: (TFile | TFolder)[],
    fileTypes: string[]
  ): (TFile | TFolder)[] {
    const allowedTypes = fileTypes.map(type => type.toLowerCase());
    return items.filter(item => {
      if (item instanceof TFile) {
        return allowedTypes.includes(item.extension.toLowerCase());
      }
      return true; // Keep folders when file type filter is applied
    });
  }

  /**
   * Apply depth filter
   * @param items Items to filter
   * @param maxDepth Maximum depth
   * @returns Filtered items
   */
  private applyDepthFilter(
    items: (TFile | TFolder)[],
    maxDepth: number
  ): (TFile | TFolder)[] {
    return items.filter(item => {
      const pathDepth = item.path.split('/').filter(p => p.length > 0).length;
      return pathDepth <= maxDepth;
    });
  }

  /**
   * Apply regex pattern filter
   * @param items Items to filter
   * @param pattern Regex pattern
   * @returns Filtered items
   */
  private applyPatternFilter(
    items: (TFile | TFolder)[],
    pattern: string
  ): (TFile | TFolder)[] {
    try {
      const regex = new RegExp(pattern, 'i');
      return items.filter(item => {
        const name = item instanceof TFile ? item.basename : item.name;
        return regex.test(item.path) || regex.test(name);
      });
    } catch (error) {
      // Invalid regex - return items unfiltered
      return items;
    }
  }

  /**
   * Apply date range filter
   * @param items Items to filter
   * @param dateRange Date range filter
   * @returns Filtered items
   */
  private applyDateRangeFilter(
    items: (TFile | TFolder)[],
    dateRange: { start?: string; end?: string }
  ): (TFile | TFolder)[] {
    const startDate = dateRange.start ? new Date(dateRange.start).getTime() : 0;
    const endDate = dateRange.end ? new Date(dateRange.end).getTime() : Date.now();

    return items.filter(item => {
      if (item instanceof TFile) {
        const modified = item.stat.mtime;
        return modified >= startDate && modified <= endDate;
      }
      return true; // Keep folders when date filter is applied
    });
  }
}
