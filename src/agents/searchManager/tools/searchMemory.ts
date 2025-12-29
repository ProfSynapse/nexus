import { Plugin } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { getErrorMessage } from '../../../utils/errorUtils';
import {
  MemorySearchParameters,
  MemorySearchResult,
  EnrichedMemorySearchResult,
  SearchMemoryModeResult,
  MemoryFilterOptions,
  FormatOptions,
  DateRange
} from '../../../types/memory/MemorySearchTypes';
import { MemorySearchProcessor, MemorySearchProcessorInterface } from '../services/MemorySearchProcessor';
import { MemorySearchFilters, MemorySearchFiltersInterface } from '../services/MemorySearchFilters';
import { ResultFormatter, ResultFormatterInterface } from '../services/ResultFormatter';
import { CommonParameters } from '../../../types/mcp/AgentTypes';
import { MemoryService } from "../../memoryManager/services/MemoryService";
import { WorkspaceService, GLOBAL_WORKSPACE_ID } from '../../../services/WorkspaceService';
import { IStorageAdapter } from '../../../database/interfaces/IStorageAdapter';
import { addRecommendations, Recommendation } from '../../../utils/recommendationUtils';
import { NudgeHelpers } from '../../../utils/nudgeHelpers';

/**
 * Memory types available for search (simplified after MemoryManager refactor)
 * - 'traces': Tool execution traces (includes tool calls)
 * - 'states': Workspace states (snapshots of work context)
 */
export type MemoryType = 'traces' | 'states';

/**
 * Session filtering options
 */
export interface SessionFilterOptions {
  currentSessionOnly?: boolean;     // Filter to current session (default: false)
  specificSessions?: string[];      // Filter to specific session IDs
  excludeSessions?: string[];       // Exclude specific session IDs
}

/**
 * Temporal filtering options for time-based search
 */
export interface TemporalFilterOptions {
  since?: string | Date;           // Results since this timestamp
  until?: string | Date;           // Results until this timestamp
  lastNHours?: number;             // Results from last N hours
  lastNDays?: number;              // Results from last N days
}

/**
 * Memory search parameters interface (simplified after MemoryManager refactor)
 */
export interface SearchMemoryParams extends CommonParameters {
  // REQUIRED PARAMETERS
  query: string;
  workspaceId: string;  // Required - states and traces are workspace-scoped

  // OPTIONAL PARAMETERS
  memoryTypes?: MemoryType[];  // 'traces' and/or 'states'
  searchMethod?: 'semantic' | 'exact' | 'mixed';
  sessionFiltering?: SessionFilterOptions;
  temporalFiltering?: TemporalFilterOptions;
  limit?: number;
  includeMetadata?: boolean;
  includeContent?: boolean;

  // Additional properties to match MemorySearchParams
  workspace?: string;
  dateRange?: DateRange;
  toolCallFilters?: any;
  filterBySession?: boolean;
}

// SearchMemoryResult extends the base type
export interface SearchMemoryResult extends SearchMemoryModeResult {}

// Legacy interface names for backward compatibility
export type { MemorySearchResult };
export type { SearchMemoryModeResult };

/**
 * Search tool focused on memory traces, sessions, states, and workspaces
 * Optimized with extracted services for better maintainability and testability
 */
export class SearchMemoryTool extends BaseTool<SearchMemoryParams, SearchMemoryResult> {
  private plugin: Plugin;
  private processor: MemorySearchProcessorInterface;
  private filters: MemorySearchFiltersInterface;
  private formatter: ResultFormatterInterface;
  private memoryService?: MemoryService;
  private workspaceService?: WorkspaceService;
  private storageAdapter?: IStorageAdapter;

  constructor(
    plugin: Plugin,
    memoryService?: MemoryService,
    workspaceService?: WorkspaceService,
    storageAdapter?: IStorageAdapter,
    processor?: MemorySearchProcessorInterface,
    filters?: MemorySearchFiltersInterface,
    formatter?: ResultFormatterInterface
  ) {
    super(
      'searchMemory',
      'Search Memory',
      'MEMORY-FOCUSED search with mandatory workspaceId parameter. Search through memory traces and states within a workspace context. Traces include tool execution history. States capture workspace snapshots. Requires: query (search terms) and workspaceId (workspace context).',
      '2.0.0'
    );

    this.plugin = plugin;
    this.memoryService = memoryService;
    this.workspaceService = workspaceService;
    this.storageAdapter = storageAdapter;

    // Initialize services with dependency injection support
    // Pass storageAdapter to processor for new backend support
    this.processor = processor || new MemorySearchProcessor(plugin, undefined, workspaceService, storageAdapter);
    this.filters = filters || new MemorySearchFilters();
    this.formatter = formatter || new ResultFormatter();
  }

  private isThinContext(context: any): boolean {
    if (!context || typeof context !== 'object') {
      return true;
    }

    const keys = Object.keys(context);
    if (keys.length === 0) {
      return true;
    }

    const nonIdKeys = keys.filter(key => !['sessionId', 'workspaceId'].includes(key));
    return nonIdKeys.length === 0;
  }

  async execute(params: SearchMemoryParams): Promise<SearchMemoryResult> {
    try {
      // Simple parameter validation
      if (!params.query || params.query.trim().length === 0) {
        return this.prepareResult(false, undefined, 'Query parameter is required and cannot be empty');
      }

      // Apply default workspace if not provided
      const workspaceId = params.workspaceId || GLOBAL_WORKSPACE_ID;
      const searchParams = { ...params, workspaceId };

      // Core processing through extracted services
      let results = await this.processor.process(searchParams);
      
      // Skip filters - return results directly
      
      // Transform results to simple format with just content, tool, and context
      // Use the raw trace data attached during enrichment
      const simplifiedResults = results.map((result: EnrichedMemorySearchResult) => {
        try {
          // Access the raw trace that was attached during enrichment
          const trace = result._rawTrace;
          if (!trace) {
            return null;
          }

          // Target canonical metadata context first, then legacy fallbacks
          let context = trace.metadata?.context;
          let source = 'metadata.context';

          const legacyParamsContext = trace.metadata?.legacy?.params?.context;
          const legacyResultContext = trace.metadata?.legacy?.result?.context;

          if (this.isThinContext(context) && legacyParamsContext) {
            context = legacyParamsContext;
            source = 'legacy.params';
          }

          if (this.isThinContext(context) && legacyResultContext) {
            context = legacyResultContext;
            source = 'legacy.result';
          }

          // Safety check: Ensure it's actually an object before trying to clean it
          if (context && typeof context === 'object' && !Array.isArray(context)) {
            // Clone it so we don't mutate the original data
            context = { ...context };

            // Remove the technical IDs we don't want
            delete context.sessionId;
            delete context.workspaceId;
          } else {
            // Fallback to empty if it's not a valid object
            context = {};
          }
          
          const entry: any = {
            content: trace.content || ''
          };
          if (trace.metadata?.tool) {
            entry.tool = trace.metadata.tool;
          }
          if (context && Object.keys(context).length > 0) {
            entry.context = context;
          }
          return entry;
        } catch (error) {
          return null;
        }
      });
      
      // Filter out nulls
      const finalResults = simplifiedResults.filter(r => r !== null);

      const result = this.prepareResult(true, {
        results: finalResults
      });

      // Generate nudges based on memory search results
      const nudges = this.generateMemorySearchNudges(results);

      return addRecommendations(result, nudges);

    } catch (error) {
      console.error('[SearchMemoryTool] Search error:', error);
      return this.prepareResult(false, undefined, `Memory search failed: ${getErrorMessage(error)}`);
    }
  }

  getParameterSchema() {
    // Create the enhanced tool-specific schema
    const toolSchema = {
      type: 'object',
      title: 'Memory Search Params',
      description: 'MEMORY-FOCUSED search with workspace context. Search through memory traces (tool execution history) and states (workspace snapshots) with temporal filtering.',
      properties: {
        query: {
          type: 'string',
          description: 'REQUIRED: Search query to find in memory content',
          minLength: 1,
          examples: ['project discussion', 'error handling', 'user feedback', 'deployment process']
        },
        workspaceId: {
          type: 'string',
          description: 'REQUIRED: Workspace context for memory search. States and traces are workspace-scoped. Use listWorkspaces to see available workspaces.',
          examples: ['project-alpha', 'research-workspace', 'global-workspace']
        },
        memoryTypes: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['traces', 'states']
          },
          description: 'Types of memory to search. "traces" includes tool execution history. "states" includes workspace snapshots. Defaults to both types.',
          default: ['traces', 'states']
        },
        dateRange: {
          type: 'object',
          properties: {
            start: {
              type: 'string',
              format: 'date',
              description: 'Start date for filtering results (ISO format)'
            },
            end: {
              type: 'string',
              format: 'date',
              description: 'End date for filtering results (ISO format)'
            }
          },
          description: 'Filter results by date range'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
          default: 20,
          minimum: 1,
          maximum: 100
        },
        toolCallFilters: {
          type: 'object',
          properties: {
            agent: {
              type: 'string',
              description: 'Filter by agent name (e.g., contentManager, searchManager)'
            },
            tool: {
              type: 'string',
              description: 'Filter by tool name (e.g., createContent, searchContent)'
            },
            success: {
              type: 'boolean',
              description: 'Filter by success status (true for successful, false for failed)'
            },
            minExecutionTime: {
              type: 'number',
              description: 'Minimum execution time in milliseconds'
            },
            maxExecutionTime: {
              type: 'number',
              description: 'Maximum execution time in milliseconds'
            }
          },
          description: 'Additional filters for tool call traces'
        },
        searchMethod: {
          type: 'string',
          enum: ['semantic', 'exact', 'mixed'],
          description: 'Search method to use',
          default: 'mixed'
        },
        filterBySession: {
          type: 'boolean',
          description: 'If true, only return traces from the current sessionId. If false or omitted, search across all sessions.',
          default: false
        }
      },
      required: ['query', 'workspaceId']
    };

    // Merge with common schema (sessionId and context) - removing duplicate definitions
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
          description: 'Memory traces ranked by relevance',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'The trace content'
              },
              tool: {
                type: 'string',
                description: 'Tool that created this trace (if applicable)'
              },
              context: {
                type: 'object',
                description: 'Additional context from the trace'
              }
            },
            required: ['content']
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

  // Private helper methods for the refactored implementation
  
  /**
   * Determine if filters should be applied
   */
  private shouldApplyFilters(params: SearchMemoryParams): boolean {
    return !!(params.dateRange || 
              params.toolCallFilters || 
              params.filterBySession || 
              params.workspace || params.workspaceId);
  }
  
  /**
   * Build filter options from parameters
   */
  private buildFilterOptions(params: SearchMemoryParams): MemoryFilterOptions {
    return {
      dateRange: params.dateRange,
      toolCallFilters: params.toolCallFilters,
      sessionId: 'default',
      workspaceId: params.workspace || params.workspaceId,
      filterBySession: params.filterBySession
    };
  }
  
  /**
   * Build format options from parameters
   */
  private buildFormatOptions(params: SearchMemoryParams): FormatOptions {
    return {
      maxHighlightLength: 200,
      contextLength: 50,
      enhanceToolCallContext: true
    };
  }

  /**
   * Generate nudges based on memory search results
   */
  private generateMemorySearchNudges(results: any[]): Recommendation[] {
    const nudges: Recommendation[] = [];

    if (!Array.isArray(results) || results.length === 0) {
      return nudges;
    }

    // Check for previous states in results
    const previousStatesNudge = NudgeHelpers.checkPreviousStates(results);
    if (previousStatesNudge) {
      nudges.push(previousStatesNudge);
    }

    // Check for workspace sessions in results
    const workspaceSessionsNudge = NudgeHelpers.checkWorkspaceSessions(results);
    if (workspaceSessionsNudge) {
      nudges.push(workspaceSessionsNudge);
    }

    return nudges;
  }
}
