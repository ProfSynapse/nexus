/**
 * Result Formatter
 *
 * Location: src/agents/searchManager/services/ResultFormatter.ts
 * Purpose: Result highlighting, metadata processing, response formatting
 * Used by: SearchMemoryMode for formatting search results and building summaries
 *
 * Refactored: Extracted specialized formatters and helpers for better maintainability.
 */

import {
  MemorySearchResult,
  FormattedMemoryResult,
  FormatOptions,
  MemorySortOption,
  MemoryGroupOption,
  GroupedMemoryResults,
  PaginatedMemoryResults,
  PaginationOptions,
  MemoryResultSummary,
  HighlightOptions,
  ResultFormatterConfiguration,
  MemoryType
} from '../../../types/memory/MemorySearchTypes';
import { BaseResultFormatter } from './formatters/BaseResultFormatter';
import { ToolCallResultFormatter } from './formatters/ToolCallResultFormatter';
import { SessionResultFormatter } from './formatters/SessionResultFormatter';
import { StateResultFormatter } from './formatters/StateResultFormatter';
import { WorkspaceResultFormatter } from './formatters/WorkspaceResultFormatter';
import { TraceResultFormatter } from './formatters/TraceResultFormatter';
import { ResultGroupingHelper } from './formatters/ResultGroupingHelper';
import { ResultSortingHelper } from './formatters/ResultSortingHelper';
import { ResultHighlightHelper } from './formatters/ResultHighlightHelper';
import { ResultSummaryHelper } from './formatters/ResultSummaryHelper';

export interface ResultFormatterInterface {
  format(results: MemorySearchResult[], options: FormatOptions): Promise<FormattedMemoryResult[]>;
  groupResults(results: MemorySearchResult[], groupBy: MemoryGroupOption): Promise<GroupedMemoryResults>;
  sortResults(results: MemorySearchResult[], sortBy: MemorySortOption): MemorySearchResult[];
  buildSummary(results: MemorySearchResult[]): Promise<MemoryResultSummary>;
  paginate(results: MemorySearchResult[], pagination: PaginationOptions): PaginatedMemoryResults;
  addHighlights(results: MemorySearchResult[], query: string, options?: HighlightOptions): Promise<MemorySearchResult[]>;
  getConfiguration(): ResultFormatterConfiguration;
  updateConfiguration(config: Partial<ResultFormatterConfiguration>): void;
}

export class ResultFormatter implements ResultFormatterInterface {
  private configuration: ResultFormatterConfiguration;
  private formatters: Map<MemoryType, BaseResultFormatter>;
  private groupingHelper: ResultGroupingHelper;
  private sortingHelper: ResultSortingHelper;
  private highlightHelper: ResultHighlightHelper;
  private summaryHelper: ResultSummaryHelper;

  constructor(config?: Partial<ResultFormatterConfiguration>) {
    this.configuration = {
      maxHighlightLength: 200,
      contextLength: 50,
      enableToolCallEnhancement: true,
      dateFormat: 'YYYY-MM-DD',
      timestampFormat: 'YYYY-MM-DD HH:mm:ss',
      ...config
    };

    // Initialize specialized formatters
    this.formatters = new Map<MemoryType, BaseResultFormatter>();
    this.formatters.set(MemoryType.TOOL_CALL, new ToolCallResultFormatter(this.configuration));
    this.formatters.set(MemoryType.SESSION, new SessionResultFormatter(this.configuration));
    this.formatters.set(MemoryType.STATE, new StateResultFormatter(this.configuration));
    this.formatters.set(MemoryType.WORKSPACE, new WorkspaceResultFormatter(this.configuration));
    this.formatters.set(MemoryType.TRACE, new TraceResultFormatter(this.configuration));

    // Initialize helpers
    this.groupingHelper = new ResultGroupingHelper();
    this.sortingHelper = new ResultSortingHelper();
    this.highlightHelper = new ResultHighlightHelper(this.configuration.maxHighlightLength);
    this.summaryHelper = new ResultSummaryHelper();
  }

  /**
   * Format search results according to options
   */
  async format(results: MemorySearchResult[], options: FormatOptions): Promise<FormattedMemoryResult[]> {
    const formatted: FormattedMemoryResult[] = [];

    for (const result of results) {
      try {
        const formatter = this.getFormatter(result.type);
        const formattedResult = await formatter.formatSingleResult(result, options);
        formatted.push(formattedResult);
      } catch (error) {
      }
    }

    return formatted;
  }

  /**
   * Group results by specified criteria
   */
  async groupResults(results: MemorySearchResult[], groupBy: MemoryGroupOption): Promise<GroupedMemoryResults> {
    return this.groupingHelper.groupResults(results, groupBy);
  }

  /**
   * Sort results by specified criteria
   */
  sortResults(results: MemorySearchResult[], sortBy: MemorySortOption): MemorySearchResult[] {
    return this.sortingHelper.sortResults(results, sortBy);
  }

  /**
   * Build result summary statistics
   */
  async buildSummary(results: MemorySearchResult[]): Promise<MemoryResultSummary> {
    return this.summaryHelper.buildSummary(results);
  }

  /**
   * Apply result pagination
   */
  paginate(results: MemorySearchResult[], pagination: PaginationOptions): PaginatedMemoryResults {
    const { page, pageSize, totalItems } = pagination;
    const actualTotalItems = totalItems || results.length;
    const totalPages = Math.ceil(actualTotalItems / pageSize);

    const startIndex = page * pageSize;
    const endIndex = Math.min(startIndex + pageSize, results.length);
    const items = results.slice(startIndex, endIndex);

    return {
      items,
      page,
      pageSize,
      totalItems: actualTotalItems,
      totalPages,
      hasNextPage: page < totalPages - 1,
      hasPreviousPage: page > 0
    };
  }

  /**
   * Generate result highlights
   */
  async addHighlights(
    results: MemorySearchResult[],
    query: string,
    options: HighlightOptions = {}
  ): Promise<MemorySearchResult[]> {
    return this.highlightHelper.addHighlights(results, query, options);
  }

  /**
   * Get current configuration
   */
  getConfiguration(): ResultFormatterConfiguration {
    return { ...this.configuration };
  }

  /**
   * Update configuration
   */
  updateConfiguration(config: Partial<ResultFormatterConfiguration>): void {
    this.configuration = { ...this.configuration, ...config };

    // Update configuration for all formatters
    this.formatters.forEach(formatter => {
      formatter.updateConfiguration(this.configuration);
    });
  }

  /**
   * Get formatter for specific memory type
   */
  private getFormatter(type: 'trace' | 'toolCall' | 'session' | 'state' | 'workspace' | 'conversation'): BaseResultFormatter {
    const formatter = this.formatters.get(type as MemoryType);
    if (formatter) {
      return formatter;
    }

    // Return trace formatter as default
    return this.formatters.get(MemoryType.TRACE)!;
  }
}
