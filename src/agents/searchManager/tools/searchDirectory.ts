/**
 * Location: /src/agents/searchManager/tools/searchDirectory.ts
 * Purpose: Unified search tool for files and folders using fuzzy matching
 *
 * This file handles directory search operations with fuzzy matching,
 * filtering, and result formatting capabilities.
 *
 * Used by: VaultLibrarian agent for directory search operations
 * Integrates with: WorkspaceService for workspace context
 * Refactored: Now uses dedicated services for item collection, filtering,
 *             fuzzy searching, and result formatting following SOLID principles
 */

import { Plugin, TFile, TFolder } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { getErrorMessage } from '../../../utils/errorUtils';
import { CommonParameters } from '../../../types/mcp/AgentTypes';
import { WorkspaceService, GLOBAL_WORKSPACE_ID } from '../../../services/WorkspaceService';
import type { ToolStatusTense } from '../../interfaces/ITool';
import { labelQuery, verbs } from '../../utils/toolStatusLabels';

// Import refactored services
import { DirectoryItemCollector } from '../services/DirectoryItemCollector';
import { SearchFilterApplicator, SearchFilters } from '../services/SearchFilterApplicator';
import { FuzzySearchEngine } from '../services/FuzzySearchEngine';
import { SearchResultFormatter, DirectoryItem } from '../services/SearchResultFormatter';

/**
 * Directory search parameters interface
 */
export interface SearchDirectoryParams extends CommonParameters {
  // REQUIRED PARAMETERS
  query: string;
  paths: string[];

  // OPTIONAL PARAMETERS
  searchType?: 'files' | 'folders' | 'both';
  fileTypes?: string[];
  depth?: number;
  includeContent?: boolean;
  limit?: number;
  pattern?: string;
  dateRange?: {
    start?: string;
    end?: string;
  };
  workspaceId?: string;
}

export interface SearchDirectoryResult {
  success: boolean;
  results: DirectoryItem[];
  error?: string;
}

/**
 * Unified search tool for both files and folders using fuzzy matching
 *
 * Follows SOLID principles with service composition:
 * - DirectoryItemCollector: Collects files/folders from paths
 * - SearchFilterApplicator: Applies various filters
 * - FuzzySearchEngine: Performs fuzzy matching
 * - SearchResultFormatter: Formats results with metadata
 */
export class SearchDirectoryTool extends BaseTool<SearchDirectoryParams, SearchDirectoryResult> {
  private plugin: Plugin;
  private workspaceService?: WorkspaceService;

  // Composed services following Dependency Inversion Principle
  private itemCollector: DirectoryItemCollector;
  private filterApplicator: SearchFilterApplicator;
  private searchEngine: FuzzySearchEngine;
  private resultFormatter: SearchResultFormatter;

  constructor(plugin: Plugin, workspaceService?: WorkspaceService) {
    super(
      'searchDirectory',
      'Search Directory',
      'FOCUSED directory search with REQUIRED paths parameter. Search for files and/or folders within specific directory paths using fuzzy matching and optional workspace context. Requires: query (search terms) and paths (directory paths to search - cannot be empty).',
      '2.0.0'
    );

    this.plugin = plugin;
    this.workspaceService = workspaceService;

    // Initialize composed services
    this.itemCollector = new DirectoryItemCollector(plugin);
    this.filterApplicator = new SearchFilterApplicator();
    this.searchEngine = new FuzzySearchEngine();
    this.resultFormatter = new SearchResultFormatter(plugin.app);
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelQuery(verbs('Searching directory', 'Searched directory', 'Failed to search directory'), params, tense);
  }

  async execute(params: SearchDirectoryParams): Promise<SearchDirectoryResult> {
    try {
      // Validate parameters
      const validationError = this.validateParams(params);
      if (validationError) {
        return this.createErrorResult(validationError);
      }

      const query = params.query.trim();
      const limit = params.limit || 20;
      const searchType = params.searchType || 'both';

      // Get items from specified directories using item collector
      const items = this.itemCollector.getDirectoryItems(
        params.paths,
        searchType,
        params.depth
      );

      // Apply workspace context if available
      const contextualItems = await this.applyWorkspaceContext(items, params.workspaceId);

      // Apply filters using filter applicator
      const filters: SearchFilters = {
        fileTypes: params.fileTypes,
        depth: params.depth,
        pattern: params.pattern,
        dateRange: params.dateRange
      };
      const filteredItems = this.filterApplicator.applyFilters(contextualItems, filters);

      // Perform fuzzy search using search engine
      const matches = this.searchEngine.performFuzzySearch(filteredItems, query);

      // Sort and limit results
      matches.sort((a, b) => b.score - a.score);
      const topMatches = matches.slice(0, limit);

      // Transform to enhanced format using result formatter
      const results = await this.resultFormatter.transformResults(
        topMatches,
        params.includeContent !== false
      );

      return this.prepareResult(true, {
        results
      });

    } catch (error) {
      return this.createErrorResult(`Directory search failed: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Validate search parameters
   * @param params Params to validate
   * @returns Error message if invalid, null if valid
   */
  private validateParams(params: SearchDirectoryParams): string | null {
    if (!params.query || params.query.trim().length === 0) {
      return 'Query parameter is required and cannot be empty';
    }

    if (!params.paths || params.paths.length === 0) {
      return 'Paths parameter is required and cannot be empty';
    }

    return null;
  }

  /**
   * Create an error result with diagnostics
   * @param errorMessage The error message
   * @returns Error result
   */
  protected createErrorResult(
    errorMessage: string
  ): SearchDirectoryResult {
    return this.prepareResult(false, undefined, errorMessage);
  }


  /**
   * Apply workspace context for boosted relevance (doesn't filter)
   * @param items Items to apply context to
   * @param workspaceId Optional workspace ID
   * @returns Items (potentially boosted if workspace context available)
   */
  private async applyWorkspaceContext(
    items: (TFile | TFolder)[],
    workspaceId?: string
  ): Promise<(TFile | TFolder)[]> {
    if (!this.workspaceService || !workspaceId || workspaceId === GLOBAL_WORKSPACE_ID) {
      return items;
    }

    try {
      const workspace = await this.workspaceService.getWorkspace(workspaceId);
      if (!workspace) {
        return items;
      }

      // For directory search, workspace context can boost relevance but doesn't filter
      // This maintains the explicit directory paths while adding workspace awareness
      return items;

    } catch {
      return items;
    }
  }

  getParameterSchema(): Record<string, unknown> {
    const toolSchema = {
      type: 'object',
      title: 'Search Directory',
      description: 'Search for files and folders within directory paths.',
      properties: {
        query: {
          type: 'string',
          description: 'Search term to find in file/folder names and paths. Fuzzy matching is automatic.',
          minLength: 1
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Directory paths to search within. Supports glob patterns. Use ["/"] for entire vault.'
        },
        searchType: {
          type: 'string',
          enum: ['files', 'folders', 'both'],
          description: 'What to search for: "files", "folders", or "both"',
          default: 'both'
        },
        fileTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by file extensions without dots'
        },
        depth: {
          type: 'number',
          description: 'Maximum directory depth to search (1-10)',
          minimum: 1,
          maximum: 10
        },
        pattern: {
          type: 'string',
          description: 'Regular expression pattern to filter paths'
        },
        dateRange: {
          type: 'object',
          properties: {
            start: {
              type: 'string',
              format: 'date',
              description: 'Start date (YYYY-MM-DD)'
            },
            end: {
              type: 'string',
              format: 'date',
              description: 'End date (YYYY-MM-DD)'
            }
          },
          description: 'Filter results by modification date range'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (1-100)',
          default: 20,
          minimum: 1,
          maximum: 100
        },
        includeContent: {
          type: 'boolean',
          description: 'Include content snippets from files',
          default: true
        }
      },
      required: ['query', 'paths'],
      additionalProperties: true,
      errorHelp: {
        missingQuery: 'The "query" parameter is required. Do NOT use "filter" - use "query" instead. Example: { "query": "summary", "paths": ["/"] }',
        missingPaths: 'The "paths" parameter is required and must be a non-empty array. Specify directories to search. Example: { "query": "summary", "paths": ["/"] }',
        emptyPaths: 'The "paths" array cannot be empty. Provide at least one directory path to search within.',
        commonMistakes: [
          'Using "filter" instead of "query" - always use "query"',
          'Forgetting the "paths" array - it\'s required',
          'Using wildcards (*) in query - just use plain text',
          'Providing paths as a string instead of array - wrap in brackets: ["/"]'
        ]
      }
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the search was successful'
        },
        results: {
          type: 'array',
          description: 'Search results ranked by relevance',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Full path to the item'
              },
              type: {
                type: 'string',
                enum: ['file', 'folder'],
                description: 'Type of the item'
              },
              snippet: {
                type: 'string',
                description: 'Content snippet (files only)'
              }
            },
            required: ['path', 'type']
          }
        },
        error: {
          type: 'string',
          description: 'Error message if failed'
        }
      },
      required: ['success', 'results']
    };
  }
}
