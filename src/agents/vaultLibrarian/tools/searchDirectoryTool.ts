/**
 * Location: /src/agents/vaultLibrarian/tools/searchDirectoryTool.ts
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

import { Plugin } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { getErrorMessage } from '../../../utils/errorUtils';
import { CommonParameters } from '../../../types/mcp/AgentTypes';
import { WorkspaceService, GLOBAL_WORKSPACE_ID } from '../../../services/WorkspaceService';

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
      const items = await this.itemCollector.getDirectoryItems(
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
    items: any[],
    workspaceId?: string
  ): Promise<any[]> {
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

    } catch (error) {
      return items;
    }
  }

  getParameterSchema() {
    const toolSchema = {
      type: 'object',
      title: 'Search Directory Tool - Find Files and Folders',
      description: 'Search for files and/or folders within specific directory paths. CRITICAL: Use "query" parameter (NOT "filter") for the search term, and "paths" array is REQUIRED.',
      properties: {
        query: {
          type: 'string',
          description: '🔍 REQUIRED: The search term to find in file/folder names and paths. Use simple text without wildcards (fuzzy matching is automatic). Examples: "summary", "project", "meeting notes"',
          minLength: 1,
          examples: ['summary', 'project', 'meeting notes', 'config', 'README']
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: '📁 REQUIRED: Array of directory paths to search within. Supports glob patterns (e.g., "folder/*.md", "**/*.ts"). Cannot be empty. Use ["/"] to search the entire vault root. Examples: ["/"] for whole vault, ["Projects/WebApp"] for specific folder, ["Notes", "Archive"] for multiple folders.',
          examples: [
            ['/'],
            ['Projects/WebApp'],
            ['Notes', 'Archive'],
            ['Work/Current Projects', 'Personal/Ideas'],
            ['**/*.md']
          ]
        },
        searchType: {
          type: 'string',
          enum: ['files', 'folders', 'both'],
          description: '🎯 What to search for: "files" (only files), "folders" (only folders), or "both" (files and folders). Default: "both"',
          default: 'both'
        },
        fileTypes: {
          type: 'array',
          items: { type: 'string' },
          description: '📄 Optional: Filter by file extensions without dots. Examples: ["md"], ["md", "txt"], ["pdf", "docx"]',
          examples: [['md'], ['md', 'txt'], ['pdf', 'docx']]
        },
        depth: {
          type: 'number',
          description: '🔢 Optional: Maximum directory depth to search (1-10). Limits how deep into subdirectories to look.',
          minimum: 1,
          maximum: 10
        },
        pattern: {
          type: 'string',
          description: '🔎 Optional: Regular expression pattern to filter paths. Advanced users only. Examples: "^Archive/", ".*Projects.*", "[0-9]{4}"',
          examples: ['^Archive/', '.*Projects.*', '[0-9]{4}']
        },
        dateRange: {
          type: 'object',
          properties: {
            start: {
              type: 'string',
              format: 'date',
              description: '📅 Start date in ISO format (YYYY-MM-DD)'
            },
            end: {
              type: 'string',
              format: 'date',
              description: '📅 End date in ISO format (YYYY-MM-DD)'
            }
          },
          description: '🗓️ Optional: Filter results by modification date range (ISO format dates)'
        },
        limit: {
          type: 'number',
          description: '🔢 Optional: Maximum number of results to return (1-100). Default: 20',
          default: 20,
          minimum: 1,
          maximum: 100
        },
        includeContent: {
          type: 'boolean',
          description: '📝 Optional: Include content snippets from files in results. Default: true',
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

  getResultSchema() {
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
