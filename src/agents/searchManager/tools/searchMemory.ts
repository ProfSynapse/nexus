import { Plugin } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { getErrorMessage } from '../../../utils/errorUtils';
import {
  MemorySearchParameters,
  MemorySearchResult,
  EnrichedMemorySearchResult,
  SearchMemoryModeResult,
  DateRange
} from '../../../types/memory/MemorySearchTypes';
import { MemorySearchProcessor, MemorySearchProcessorInterface, SearchMetadata, SearchProcessResult } from '../services/MemorySearchProcessor';
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
 * - 'conversations': Conversation QA pairs via semantic embedding search
 */
export type MemoryType = 'traces' | 'states' | 'conversations';

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
  workspaceId?: string;  // Optional - defaults to GLOBAL_WORKSPACE_ID if omitted

  // OPTIONAL PARAMETERS
  memoryTypes?: MemoryType[];  // 'traces', 'states', and/or 'conversations'
  searchMethod?: 'semantic' | 'exact' | 'mixed';
  sessionFiltering?: SessionFilterOptions;
  temporalFiltering?: TemporalFilterOptions;
  limit?: number;
  includeMetadata?: boolean;
  includeContent?: boolean;
  /** Optional session ID for scoped conversation search. When provided, search returns N-turn windows around matches. */
  sessionId?: string;
  /** Number of conversation turns before/after each match to include. Default 3. Only used in scoped mode. */
  windowSize?: number;

  // Additional properties to match MemorySearchParams
  workspace?: string;
  dateRange?: DateRange;
  toolCallFilters?: any;
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
      'Search workspace memory for past conversations, tool execution history, and workspace state snapshots.\n\nTWO MODES:\n- Discovery (default): Search all memory across a workspace. Best for finding past discussions, tool usage, or workspace context.\n- Scoped (provide sessionId): Search within a specific session and get surrounding message context around each match. Best for recovering what happened in a particular session.\n\nTIPS:\n- Use natural language queries for conversations (e.g., "how did we implement auth?").\n- Use specific terms for tool history (e.g., agent or tool names).\n- Narrow results with memoryTypes if you know what you\'re looking for.\n- Use sessionId + windowSize to get full context around a match.\n\nREQUIRES: query. Optional: workspaceId (defaults to global workspace if omitted; available from your useTools context, or use MemoryManager listWorkspaces).',
      '2.1.0'
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
      const { results, metadata } = await this.processor.process(searchParams);

      // Skip filters - return results directly

      // Transform results to simple format
      // Use the raw trace data attached during enrichment
      const simplifiedResults = results.map((result: EnrichedMemorySearchResult) => {
        try {
          // Access the raw trace that was attached during enrichment
          const trace = result._rawTrace;
          if (!trace) {
            return null;
          }

          // Conversation results have a different structure than trace/state results
          if (trace.type === 'conversation') {
            return this.formatConversationResult(trace);
          }

          // Standard trace/state result formatting
          return this.formatTraceResult(trace);
        } catch (error) {
          return null;
        }
      });
      
      // Filter out nulls
      const finalResults = simplifiedResults.filter(r => r !== null);

      // Provide actionable guidance when no results are found
      if (finalResults.length === 0) {
        return this.prepareResult(false, undefined, this.buildEmptyResultGuidance(searchParams, metadata));
      }

      const result = this.prepareResult(true, {
        results: finalResults
      });

      // Generate nudges based on memory search results
      const nudges = this.generateMemorySearchNudges(results, metadata);

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
      description: 'Search workspace memory for past conversations, tool execution history, and workspace state snapshots. Two modes: Discovery (default, workspace-wide) and Scoped (provide sessionId for N-turn context windows).',
      properties: {
        query: {
          type: 'string',
          description: "What to search for. Use natural language for conversations ('how did we handle auth?') or specific terms for tool history ('contentManager readContent'). Examples: 'authentication implementation', 'database migration error', 'what tools were used for file editing'",
          minLength: 1
        },
        workspaceId: {
          type: 'string',
          description: 'Workspace to search in. Optional — defaults to the global workspace if omitted. Available from your useTools context.workspaceId, or use MemoryManager listWorkspaces to discover workspaces.'
        },
        memoryTypes: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['traces', 'states', 'conversations']
          },
          description: "Which memory to search. 'conversations' = past chat Q&A pairs, 'traces' = tool execution history, 'states' = workspace snapshots. Defaults to all three. Narrow to specific types if you know what you need.",
          default: ['traces', 'states', 'conversations']
        },
        sessionId: {
          type: 'string',
          description: 'Provide a session ID to switch to Scoped mode: search is limited to this session and returns surrounding messages around each match. Use MemoryManager listSessions to find session IDs.'
        },
        windowSize: {
          type: 'number',
          description: 'Number of conversation turns before/after each match to include. Default 3. Only used in scoped mode (when sessionId is provided).',
          default: 3,
          minimum: 1,
          maximum: 20
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
              description: 'Filter by agent name'
            },
            tool: {
              type: 'string',
              description: 'Filter by tool name'
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
          description: "How to match results. 'mixed' (default, recommended) combines approaches for best coverage. 'semantic' prioritizes meaning-based matching. 'exact' requires literal keyword matches.",
          default: 'mixed'
        }
      },
      required: ['query']
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
          description: 'Memory results ranked by relevance. Includes trace/state results and conversation QA pair results.',
          items: {
            type: 'object',
            properties: {
              // Trace/state result fields
              content: {
                type: 'string',
                description: 'The trace content (trace/state results)'
              },
              tool: {
                type: 'string',
                description: 'Tool that created this trace (if applicable)'
              },
              context: {
                type: 'object',
                description: 'Additional context from the trace'
              },
              // Conversation result fields
              type: {
                type: 'string',
                description: 'Result type. "conversation" for conversation QA pair results.'
              },
              conversationTitle: {
                type: 'string',
                description: 'Title of the matched conversation'
              },
              conversationId: {
                type: 'string',
                description: 'ID of the matched conversation'
              },
              question: {
                type: 'string',
                description: 'The user message in the matched QA pair'
              },
              answer: {
                type: 'string',
                description: 'The assistant response in the matched QA pair'
              },
              matchedSide: {
                type: 'string',
                enum: ['question', 'answer'],
                description: 'Which side of the QA pair matched the query'
              },
              pairType: {
                type: 'string',
                enum: ['conversation_turn', 'trace_pair'],
                description: 'Whether this is a conversation turn or tool trace pair'
              },
              windowMessages: {
                type: 'array',
                description: 'Surrounding messages for context (scoped mode only). N turns before and after the match.',
                items: {
                  type: 'object',
                  properties: {
                    role: { type: 'string' },
                    content: { type: 'string' },
                    sequenceNumber: { type: 'number' }
                  }
                }
              }
            }
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

  /**
   * Format a conversation QA pair result for the tool response.
   * Returns a structured object with type 'conversation', the matched Q/A pair,
   * conversation metadata, and optional windowed messages for scoped search.
   */
  private formatConversationResult(trace: Record<string, unknown>): Record<string, unknown> {
    const entry: Record<string, unknown> = {
      type: 'conversation',
      conversationTitle: trace.conversationTitle || 'Untitled',
      conversationId: trace.conversationId,
      question: trace.question || '',
      answer: trace.answer || '',
      matchedSide: trace.matchedSide,
      pairType: trace.pairType
    };

    // Include windowed messages when available (scoped mode)
    if (Array.isArray(trace.windowMessages) && trace.windowMessages.length > 0) {
      entry.windowMessages = (trace.windowMessages as Array<Record<string, unknown>>).map((msg) => ({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : '',
        sequenceNumber: msg.sequenceNumber
      }));
    }

    return entry;
  }

  /**
   * Format a standard trace/state result for the tool response.
   * Extracts content, tool name, and context from the raw trace metadata.
   */
  private formatTraceResult(trace: Record<string, unknown>): Record<string, unknown> | null {
    // Target canonical metadata context first, then legacy fallbacks
    const metadata = trace.metadata as Record<string, unknown> | undefined;
    let context = metadata?.context as Record<string, unknown> | undefined;

    const legacy = metadata?.legacy as Record<string, unknown> | undefined;
    const legacyParamsContext = (legacy?.params as Record<string, unknown> | undefined)?.context as Record<string, unknown> | undefined;
    const legacyResultContext = (legacy?.result as Record<string, unknown> | undefined)?.context as Record<string, unknown> | undefined;

    if (this.isThinContext(context) && legacyParamsContext) {
      context = legacyParamsContext;
    }

    if (this.isThinContext(context) && legacyResultContext) {
      context = legacyResultContext;
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

    const entry: Record<string, unknown> = {
      content: (trace.content as string) || ''
    };
    if (metadata?.tool) {
      entry.tool = metadata.tool;
    }
    if (context && Object.keys(context).length > 0) {
      entry.context = context;
    }
    return entry;
  }

  /**
   * Build actionable guidance message when search returns no results.
   * Includes information about unavailable or failed memory types
   * and suggestions for broadening the search.
   */
  private buildEmptyResultGuidance(params: SearchMemoryParams, metadata: SearchMetadata): string {
    const parts: string[] = ['No results found.'];

    if (metadata.typesUnavailable.length > 0) {
      parts.push(`Note: ${metadata.typesUnavailable.join(', ')} search was unavailable — only ${metadata.typesSearched.join(', ')} were searched.`);
    }

    if (metadata.typesFailed.length > 0) {
      parts.push(`Warning: search failed for ${metadata.typesFailed.join(', ')}.`);
    }

    parts.push('Try: (1) broader or rephrased search terms, (2) verify workspaceId is correct (use MemoryManager listWorkspaces), (3) try different memoryTypes.');

    if (params.sessionId) {
      parts.push('(4) Remove sessionId to search the full workspace instead of one session.');
    }

    return parts.join(' ');
  }

  /**
   * Generate nudges based on memory search results
   */
  private generateMemorySearchNudges(results: any[], metadata: SearchMetadata): Recommendation[] {
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

    // Degraded search nudges
    if (metadata.typesUnavailable.length > 0) {
      nudges.push({
        type: 'partial_search',
        message: `Only ${metadata.typesSearched.join(', ')} were searched. ${metadata.typesUnavailable.join(', ')} search was unavailable — results may be incomplete.`
      });
    }
    if (metadata.typesFailed.length > 0) {
      nudges.push({
        type: 'search_error',
        message: `Search failed for ${metadata.typesFailed.join(', ')}. Results may be incomplete. Retry may resolve transient errors.`
      });
    }

    return nudges;
  }
}
