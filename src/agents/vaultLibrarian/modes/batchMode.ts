import { Plugin } from 'obsidian';
import { BaseMode } from '../../baseMode';
import { MemoryService } from "../../memoryManager/services/MemoryService";
import { WorkspaceService } from '../../../services/WorkspaceService';
import { getErrorMessage } from '../../../utils/errorUtils';
import { CommonParameters, CommonResult } from '../../../types/mcp/AgentTypes';
import { IStorageAdapter } from '../../../database/interfaces/IStorageAdapter';

// Import the lean search modes
import { SearchContentMode, ContentSearchParams, ContentSearchResult } from './searchContentMode';
import { SearchDirectoryMode, SearchDirectoryParams, SearchDirectoryResult } from './searchDirectoryMode';
import { SearchMemoryMode, SearchMemoryParams, SearchMemoryResult } from './searchMemoryMode';

/**
 * Individual search specification for batch execution
 */
export interface BatchSearchSpec {
  mode: 'content' | 'directory' | 'memory';

  // Common params
  query: string;
  limit?: number;

  // Content mode specific
  semantic?: boolean;  // Required for content mode
  paths?: string[];    // Used by both content and directory

  // Memory mode specific
  workspaceId?: string;
  memoryTypes?: ('traces' | 'toolCalls' | 'sessions' | 'states' | 'workspaces')[];

  // Directory mode specific
  searchType?: 'files' | 'folders' | 'both';
  fileTypes?: string[];
}

/**
 * Batch search parameters - orchestrates multiple lean searches
 */
export interface BatchSearchParams extends CommonParameters {
  searches: BatchSearchSpec[];
  maxConcurrency?: number;
}

/**
 * Individual search result wrapper
 */
export interface BatchSearchResultItem {
  mode: 'content' | 'directory' | 'memory';
  success: boolean;
  results?: any[];
  error?: string;
}

/**
 * Batch search result - lean combined output
 */
export interface BatchSearchResult extends CommonResult {
  results: BatchSearchResultItem[];
}

/**
 * Batch mode for executing multiple lean searches concurrently
 * Directly orchestrates SearchContentMode, SearchDirectoryMode, SearchMemoryMode
 */
export class BatchMode extends BaseMode<BatchSearchParams, BatchSearchResult> {
  private plugin: Plugin;
  private memoryService?: MemoryService;
  private workspaceService?: WorkspaceService;
  private storageAdapter?: IStorageAdapter;

  constructor(
    plugin: Plugin,
    memoryService?: MemoryService,
    workspaceService?: WorkspaceService,
    storageAdapter?: IStorageAdapter
  ) {
    super(
      'batch',
      'Batch Search',
      'Execute multiple searches concurrently across content, directory, and memory. Each search uses lean result format. Use when you need to run several different searches at once.',
      '3.0.0'
    );

    this.plugin = plugin;
    this.memoryService = memoryService;
    this.workspaceService = workspaceService;
    this.storageAdapter = storageAdapter;
  }

  async execute(params: BatchSearchParams): Promise<BatchSearchResult> {
    try {
      // Validate parameters
      if (!params.searches || params.searches.length === 0) {
        return this.prepareResult(false, undefined, 'At least one search is required');
      }

      const maxConcurrency = params.maxConcurrency || 5;

      // Validate search specs
      for (const spec of params.searches) {
        if (!spec.mode) {
          return this.prepareResult(false, undefined, 'Each search must specify a mode (content, directory, or memory)');
        }
        if (!spec.query || spec.query.trim().length === 0) {
          return this.prepareResult(false, undefined, 'Each search must have a non-empty query');
        }
        if (spec.mode === 'content' && spec.semantic === undefined) {
          return this.prepareResult(false, undefined, 'Content searches require semantic parameter (true or false)');
        }
        if (spec.mode === 'directory' && (!spec.paths || spec.paths.length === 0)) {
          return this.prepareResult(false, undefined, 'Directory searches require paths array');
        }
      }

      // Execute searches with concurrency control
      const results = await this.executeConcurrentSearches(params.searches, params.context, maxConcurrency);

      return this.prepareResult(true, { results });

    } catch (error) {
      return this.prepareResult(false, undefined, `Batch search failed: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Execute searches with concurrency control
   */
  private async executeConcurrentSearches(
    searches: BatchSearchSpec[],
    context: CommonParameters['context'],
    maxConcurrency: number
  ): Promise<BatchSearchResultItem[]> {
    const results: BatchSearchResultItem[] = [];

    // Process searches in batches to control concurrency
    for (let i = 0; i < searches.length; i += maxConcurrency) {
      const batch = searches.slice(i, i + maxConcurrency);

      const batchPromises = batch.map(async (spec, index) => {
        try {
          // Small delay between concurrent searches
          if (index > 0) {
            await new Promise(resolve => setTimeout(resolve, index * 50));
          }

          return await this.executeSearch(spec, context);
        } catch (error) {
          return {
            mode: spec.mode,
            success: false,
            error: `Search failed: ${getErrorMessage(error)}`
          } as BatchSearchResultItem;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Execute a single search using the appropriate mode
   */
  private async executeSearch(
    spec: BatchSearchSpec,
    context: CommonParameters['context']
  ): Promise<BatchSearchResultItem> {
    switch (spec.mode) {
      case 'content':
        return this.executeContentSearch(spec, context);
      case 'directory':
        return this.executeDirectorySearch(spec, context);
      case 'memory':
        return this.executeMemorySearch(spec, context);
      default:
        return {
          mode: spec.mode,
          success: false,
          error: `Unknown search mode: ${spec.mode}`
        };
    }
  }

  /**
   * Execute content search
   */
  private async executeContentSearch(
    spec: BatchSearchSpec,
    context: CommonParameters['context']
  ): Promise<BatchSearchResultItem> {
    const contentMode = new SearchContentMode(this.plugin);

    const params: ContentSearchParams = {
      query: spec.query,
      semantic: spec.semantic!,
      limit: spec.limit,
      paths: spec.paths,
      context
    };

    const result = await contentMode.execute(params) as ContentSearchResult;

    return {
      mode: 'content',
      success: result.success,
      results: result.results,
      error: result.error
    };
  }

  /**
   * Execute directory search
   */
  private async executeDirectorySearch(
    spec: BatchSearchSpec,
    context: CommonParameters['context']
  ): Promise<BatchSearchResultItem> {
    const directoryMode = new SearchDirectoryMode(this.plugin, this.workspaceService);

    const params: SearchDirectoryParams = {
      query: spec.query,
      paths: spec.paths!,
      searchType: spec.searchType,
      fileTypes: spec.fileTypes,
      limit: spec.limit,
      context
    };

    const result = await directoryMode.execute(params) as SearchDirectoryResult;

    return {
      mode: 'directory',
      success: result.success,
      results: result.results,
      error: result.error
    };
  }

  /**
   * Execute memory search
   */
  private async executeMemorySearch(
    spec: BatchSearchSpec,
    context: CommonParameters['context']
  ): Promise<BatchSearchResultItem> {
    const memoryMode = new SearchMemoryMode(
      this.plugin,
      this.memoryService,
      this.workspaceService,
      this.storageAdapter
    );

    const params: SearchMemoryParams = {
      query: spec.query,
      workspaceId: spec.workspaceId || 'global-workspace',
      memoryTypes: spec.memoryTypes,
      limit: spec.limit,
      context
    };

    const result = await memoryMode.execute(params) as SearchMemoryResult;

    return {
      mode: 'memory',
      success: result.success,
      results: result.results,
      error: result.error
    };
  }

  getParameterSchema() {
    const batchSchema = {
      type: 'object',
      title: 'Batch Search Params',
      description: 'Execute multiple searches concurrently. Each search specifies its mode (content, directory, or memory) and mode-specific parameters.',
      properties: {
        searches: {
          type: 'array',
          description: 'Array of search specifications to execute concurrently',
          items: {
            type: 'object',
            title: 'Search Specification',
            description: 'A single search with mode and mode-specific parameters',
            properties: {
              mode: {
                type: 'string',
                enum: ['content', 'directory', 'memory'],
                description: 'REQUIRED: Search mode - "content" (file contents with semantic/keyword), "directory" (file/folder names), or "memory" (traces/sessions/states)'
              },
              query: {
                type: 'string',
                description: 'REQUIRED: Search query text',
                minLength: 1
              },
              limit: {
                type: 'number',
                description: 'Maximum results to return (default: 20)',
                default: 20,
                minimum: 1,
                maximum: 100
              },
              semantic: {
                type: 'boolean',
                description: 'REQUIRED for content mode: true for semantic/vector search, false for keyword search'
              },
              paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'REQUIRED for directory mode, optional for content mode: Folder paths to search. Use ["/"] for entire vault.'
              },
              workspaceId: {
                type: 'string',
                description: 'For memory mode: Workspace context (default: "global-workspace")'
              },
              memoryTypes: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['traces', 'toolCalls', 'sessions', 'states', 'workspaces']
                },
                description: 'For memory mode: Types of memory to search'
              },
              searchType: {
                type: 'string',
                enum: ['files', 'folders', 'both'],
                description: 'For directory mode: What to search for (default: "both")'
              },
              fileTypes: {
                type: 'array',
                items: { type: 'string' },
                description: 'For directory mode: Filter by file extensions (without dots)'
              }
            },
            required: ['mode', 'query']
          },
          minItems: 1,
          maxItems: 20
        },
        maxConcurrency: {
          type: 'number',
          description: 'Maximum concurrent searches (default: 5)',
          minimum: 1,
          maximum: 10,
          default: 5
        }
      },
      required: ['searches'],
      additionalProperties: false
    };

    return this.getMergedSchema(batchSchema);
  }

  getResultSchema() {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the batch search was successful'
        },
        results: {
          type: 'array',
          description: 'Array of search results, one per search specification',
          items: {
            type: 'object',
            properties: {
              mode: {
                type: 'string',
                enum: ['content', 'directory', 'memory'],
                description: 'The search mode that was executed'
              },
              success: {
                type: 'boolean',
                description: 'Whether this individual search succeeded'
              },
              results: {
                type: 'array',
                description: 'Search results in the lean format for the mode'
              },
              error: {
                type: 'string',
                description: 'Error message if this search failed'
              }
            },
            required: ['mode', 'success']
          }
        },
        error: {
          type: 'string',
          description: 'Error message if batch search failed entirely'
        }
      },
      required: ['success', 'results']
    };
  }
}
