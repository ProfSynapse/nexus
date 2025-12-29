/**
 * Memory Search Processor
 * 
 * Location: src/agents/searchManager/services/MemorySearchProcessor.ts
 * Purpose: Core search logic across multiple memory types (traces, sessions, workspaces, etc.)
 * Used by: SearchMemoryMode for processing search requests and enriching results
 */

import { App, Plugin, prepareFuzzySearch } from 'obsidian';
import {
  MemorySearchParameters,
  MemorySearchResult,
  EnrichedMemorySearchResult,
  RawMemoryResult,
  MemorySearchContext,
  MemorySearchExecutionOptions,
  SearchOptions,
  ValidationResult,
  MemoryProcessorConfiguration,
  SearchMethod,
  MemoryType
} from '../../../types/memory/MemorySearchTypes';
import { MemoryService } from "../../memoryManager/services/MemoryService";
import { WorkspaceService, GLOBAL_WORKSPACE_ID } from '../../../services/WorkspaceService';
import { IStorageAdapter } from '../../../database/interfaces/IStorageAdapter';
import { MemoryTraceData, StateMetadata } from '../../../types/storage/HybridStorageTypes';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import type NexusPlugin from '../../../main';

export interface MemorySearchProcessorInterface {
  process(params: MemorySearchParameters): Promise<EnrichedMemorySearchResult[]>;
  validateParameters(params: MemorySearchParameters): ValidationResult;
  executeSearch(query: string, options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]>;
  enrichResults(results: RawMemoryResult[], context: MemorySearchContext): Promise<EnrichedMemorySearchResult[]>;
  getConfiguration(): MemoryProcessorConfiguration;
  updateConfiguration(config: Partial<MemoryProcessorConfiguration>): Promise<void>;
}

export class MemorySearchProcessor implements MemorySearchProcessorInterface {
  private plugin: Plugin;
  private configuration: MemoryProcessorConfiguration;
  private workspaceService?: WorkspaceService;
  private storageAdapter?: IStorageAdapter;

  constructor(
    plugin: Plugin,
    config?: Partial<MemoryProcessorConfiguration>,
    workspaceService?: WorkspaceService,
    storageAdapter?: IStorageAdapter
  ) {
    this.plugin = plugin;
    this.workspaceService = workspaceService;
    this.storageAdapter = storageAdapter;
    this.configuration = {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSearchMethod: SearchMethod.EXACT,
      enableSemanticSearch: false,
      enableExactSearch: true,
      timeoutMs: 30000,
      ...config
    };
  }

  /**
   * Main processing entry point
   */
  async process(params: MemorySearchParameters): Promise<EnrichedMemorySearchResult[]> {
    // Validate parameters
    const validation = this.validateParameters(params);
    if (!validation.isValid) {
      throw new Error(`Invalid parameters: ${validation.errors.join(', ')}`);
    }

    // Build search context
    const context: MemorySearchContext = {
      params,
      timestamp: new Date()
    };

    // Execute search across all specified memory types
    const searchOptions = this.buildSearchOptions(params);
    const rawResults = await this.executeSearch(params.query, searchOptions);

    // Enrich results with metadata and context
    return this.enrichResults(rawResults, context);
  }

  /**
   * Validates search parameters
   */
  validateParameters(params: MemorySearchParameters): ValidationResult {
    const errors: string[] = [];

    // Required fields
    if (!params.query || params.query.trim().length === 0) {
      errors.push('Query parameter is required and cannot be empty');
    }

    // Limit validation
    if (params.limit !== undefined) {
      if (params.limit < 1) {
        errors.push('Limit must be positive');
      }
      if (params.limit > this.configuration.maxLimit) {
        errors.push(`Limit cannot exceed ${this.configuration.maxLimit}`);
      }
    }

    // Date range validation
    if (params.dateRange) {
      if (params.dateRange.start && params.dateRange.end) {
        const startDate = new Date(params.dateRange.start);
        const endDate = new Date(params.dateRange.end);
        
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

    // Tool call filters validation
    if (params.toolCallFilters) {
      const filters = params.toolCallFilters;
      if (filters.minExecutionTime !== undefined && filters.minExecutionTime < 0) {
        errors.push('Minimum execution time must be non-negative');
      }
      if (filters.maxExecutionTime !== undefined && filters.maxExecutionTime < 0) {
        errors.push('Maximum execution time must be non-negative');
      }
      if (filters.minExecutionTime !== undefined && 
          filters.maxExecutionTime !== undefined && 
          filters.minExecutionTime > filters.maxExecutionTime) {
        errors.push('Minimum execution time must be less than maximum execution time');
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Execute search across all memory types
   */
  async executeSearch(query: string, options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]> {
    const results: RawMemoryResult[] = [];
    const searchPromises: Promise<RawMemoryResult[]>[] = [];

    // Get default memory types if not specified
    const memoryTypes = options.memoryTypes || ['traces', 'toolCalls', 'sessions', 'states', 'workspaces'];
    const limit = options.limit || this.configuration.defaultLimit;

    // Search legacy traces
    if (memoryTypes.includes('traces')) {
      searchPromises.push(this.searchLegacyTraces(query, options));
    }

    // Search tool call traces
    if (memoryTypes.includes('toolCalls')) {
      searchPromises.push(this.searchToolCallTraces(query, options));
    }

    // Search sessions
    if (memoryTypes.includes('sessions')) {
      searchPromises.push(this.searchSessions(query, options));
    }

    // Search states
    if (memoryTypes.includes('states')) {
      searchPromises.push(this.searchStates(query, options));
    }

    // Search workspaces
    if (memoryTypes.includes('workspaces')) {
      searchPromises.push(this.searchWorkspaces(query, options));
    }

    // Execute all searches in parallel
    const searchResults = await Promise.allSettled(searchPromises);
    
    // Collect results from successful searches
    for (const result of searchResults) {
      if (result.status === 'fulfilled') {
        results.push(...result.value);
      } else {
        console.error('[MemorySearchProcessor] Search error:', result.reason);
      }
    }

    // Sort by score and apply limit
    results.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    return results.slice(0, limit);
  }

  /**
   * Enrich raw results with metadata and context
   */
  async enrichResults(results: RawMemoryResult[], context: MemorySearchContext): Promise<EnrichedMemorySearchResult[]> {
    const enrichedResults: EnrichedMemorySearchResult[] = [];

    for (const result of results) {
      try {
        const enriched = await this.enrichSingleResult(result, context);
        if (enriched) {
          enrichedResults.push(enriched);
        }
      } catch (error) {
      }
    }

    return enrichedResults;
  }

  /**
   * Get current configuration
   */
  getConfiguration(): MemoryProcessorConfiguration {
    return { ...this.configuration };
  }

  /**
   * Update configuration
   */
  async updateConfiguration(config: Partial<MemoryProcessorConfiguration>): Promise<void> {
    this.configuration = { ...this.configuration, ...config };
  }

  // Private helper methods

  private buildSearchOptions(params: MemorySearchParameters): MemorySearchExecutionOptions {
    return {
      workspaceId: params.workspaceId || params.workspace,
      sessionId: params.filterBySession ? params.context.sessionId : undefined,
      limit: params.limit || this.configuration.defaultLimit,
      toolCallFilters: params.toolCallFilters
    };
  }

  private async searchLegacyTraces(query: string, options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]> {
    const workspaceId = options.workspaceId || GLOBAL_WORKSPACE_ID;

    // Use new storage adapter if available
    if (this.storageAdapter) {
      try {
        const result = await this.storageAdapter.searchTraces(
          workspaceId,
          query,
          options.sessionId
        );

        // Convert MemoryTraceData to RawMemoryResult format
        return result.map((trace: MemoryTraceData) => ({
          trace: {
            id: trace.id,
            workspaceId: trace.workspaceId,
            sessionId: trace.sessionId,
            timestamp: trace.timestamp,
            type: trace.type || 'generic',
            content: trace.content,
            metadata: trace.metadata
          },
          similarity: 1.0 // SQLite FTS doesn't provide scores, default to 1.0
        }));
      } catch (error) {
        console.error('[MemorySearchProcessor] Error searching traces via storage adapter:', error);
        return [];
      }
    }

    // Legacy path: use WorkspaceService
    const workspaceService = this.workspaceService || this.getWorkspaceService();

    if (!workspaceService) {
      return [];
    }

    try {
      // Get the entire workspace
      const workspace = await workspaceService.getWorkspace(workspaceId);
      if (!workspace) {
        return [];
      }

      // Use Obsidian's native fuzzy search API
      const fuzzySearch = prepareFuzzySearch(query.toLowerCase());
      const results: RawMemoryResult[] = [];

      // Loop through all sessions
      if (workspace.sessions) {
        for (const [sessionId, session] of Object.entries(workspace.sessions)) {
          // Loop through all traces in each session
          const traces = Object.values(session.memoryTraces || {});

          for (const trace of traces) {
            // Convert THIS trace to JSON string
            const traceJSON = JSON.stringify(trace);

            // Fuzzy search this individual trace's JSON
            const match = fuzzySearch(traceJSON);

            if (match) {
              // Normalize fuzzy score (negative to positive)
              const normalizedScore = Math.max(0, Math.min(1, 1 + (match.score / 100)));

              // Return the FULL trace object with workspaceId and sessionId added
              results.push({
                trace: {
                  ...trace,
                  workspaceId,
                  sessionId
                },
                similarity: normalizedScore
              });
            }
          }
        }
      }

      // Sort by score (highest first)
      results.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));

      // Apply limit if specified
      const limited = options.limit ? results.slice(0, options.limit) : results;

      return limited;
    } catch (error) {
      console.error('[MemorySearchProcessor] Error searching legacy traces:', error);
      return [];
    }
  }

  /**
   * Extract searchable text from a memory trace
   * Combines all relevant fields for comprehensive search
   */
  private getSearchableText(trace: any): string {
    const parts: string[] = [];
    
    if (trace.content) parts.push(trace.content);
    if (trace.type) parts.push(trace.type);
    if (trace.metadata) {
      // Include metadata fields in search
      if (trace.metadata.tool) parts.push(trace.metadata.tool);
      if (trace.metadata.params) {
        // Stringify params for search
        try {
          parts.push(JSON.stringify(trace.metadata.params));
        } catch (e) {
          // Ignore JSON errors
        }
      }
    }
    
    return parts.join(' ');
  }

  private async searchToolCallTraces(query: string, options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]> {
    // MemoryTraceService not available in simplified architecture
    return [];
  }

  private async searchSessions(query: string, options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]> {
    const memoryService = this.getMemoryService();
    if (!memoryService) return [];

    try {
      const sessionsResult = await memoryService.getSessions(options.workspaceId || GLOBAL_WORKSPACE_ID);
      const sessions = sessionsResult.items;
      const queryLower = query.toLowerCase();
      const results: RawMemoryResult[] = [];

      for (const session of sessions) {
        let score = 0;
        
        // Check name match
        if ((session.name || '').toLowerCase().includes(queryLower)) {
          score += 0.9;
        }
        
        // Check description match
        if (session.description?.toLowerCase().includes(queryLower)) {
          score += 0.8;
        }

        if (score > 0) {
          results.push({
            trace: session,
            similarity: score
          });
        }
      }

      return results;
    } catch (error) {
      console.error('[MemorySearchProcessor] Error searching sessions:', error);
      return [];
    }
  }

  private async searchStates(query: string, options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]> {
    const memoryService = this.getMemoryService();
    if (!memoryService) return [];

    try {
      const statesResult = await memoryService.getStates(options.workspaceId || GLOBAL_WORKSPACE_ID, options.sessionId);
      const queryLower = query.toLowerCase();
      const results: RawMemoryResult[] = [];

      for (const state of statesResult.items) {
        let score = 0;

        // Check name match
        if (state.name.toLowerCase().includes(queryLower)) {
          score += 0.9;
        }

        // Note: State items from getStates don't have description, only id/name/created/state

        if (score > 0) {
          results.push({
            trace: state,
            similarity: score
          });
        }
      }

      return results;
    } catch (error) {
      console.error('[MemorySearchProcessor] Error searching states:', error);
      return [];
    }
  }

  private async searchWorkspaces(query: string, options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]> {
    const workspaceService = this.getWorkspaceService();
    if (!workspaceService) return [];

    try {
      const workspaces = await workspaceService.listWorkspaces();
      const queryLower = query.toLowerCase();
      const results: RawMemoryResult[] = [];

      for (const workspace of workspaces) {
        let score = 0;
        
        // Check name match
        if (workspace.name.toLowerCase().includes(queryLower)) {
          score += 0.9;
        }
        
        // Check description match
        if (workspace.description?.toLowerCase().includes(queryLower)) {
          score += 0.8;
        }

        if (score > 0) {
          results.push({
            trace: workspace,
            similarity: score
          });
        }
      }

      return results;
    } catch (error) {
      console.error('[MemorySearchProcessor] Error searching workspaces:', error);
      return [];
    }
  }

  private async searchToolCallsExact(query: string, options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]> {
    // MemoryTraceService not available in simplified architecture
    return [];
  }

  private async enrichSingleResult(result: RawMemoryResult, context: MemorySearchContext): Promise<EnrichedMemorySearchResult | null> {
    const trace = result.trace;
    const query = context.params.query;

    try {
      // Determine result type
      const resultType = this.determineResultType(trace);

      // Generate highlight
      const highlight = this.generateHighlight(trace, query);

      // Build metadata
      const metadata = this.buildMetadata(trace, resultType);

      // Generate context
      const searchContext = this.generateSearchContext(trace, query, resultType);

      const enrichedResult: EnrichedMemorySearchResult = {
        type: resultType,
        id: trace.id,
        highlight,
        metadata,
        context: searchContext,
        score: result.similarity || 0,
        _rawTrace: trace  // Attach raw trace for downstream processing
      };

      return enrichedResult;
    } catch (error) {
      console.error('[MemorySearchProcessor] Failed to enrich result:', {
        error,
        traceId: trace?.id,
        trace
      });
      return null;
    }
  }

  private determineResultType(trace: any): MemoryType {
    // Check for tool call specific properties
    if ('toolCallId' in trace && trace.toolCallId) return MemoryType.TOOL_CALL;
    // Check for session specific properties
    if ('name' in trace && 'startTime' in trace && trace.startTime !== undefined) return MemoryType.SESSION;
    // Check for state specific properties
    if ('name' in trace && 'timestamp' in trace && trace.timestamp !== undefined) return MemoryType.STATE;
    // Check for workspace specific properties
    if ('name' in trace && 'created' in trace && trace.created !== undefined) return MemoryType.WORKSPACE;
    return MemoryType.TRACE;
  }

  private generateHighlight(trace: any, query: string): string {
    const maxLength = 200;
    const content = trace.content || trace.description || trace.name || '';
    const queryLower = query.toLowerCase();
    const contentLower = content.toLowerCase();
    
    const index = contentLower.indexOf(queryLower);
    if (index === -1) {
      return content.substring(0, maxLength) + (content.length > maxLength ? '...' : '');
    }
    
    const start = Math.max(0, index - 50);
    const end = Math.min(content.length, index + query.length + 50);
    
    let highlight = content.substring(start, end);
    if (start > 0) highlight = '...' + highlight;
    if (end < content.length) highlight = highlight + '...';
    
    return highlight;
  }

  private buildMetadata(trace: any, resultType: MemoryType): any {
    const metadata = trace.metadata || {};
    const context = metadata.context || {};
    const baseMetadata = {
      created: trace.timestamp ? new Date(trace.timestamp).toISOString() : 
               trace.startTime ? new Date(trace.startTime).toISOString() :
               trace.created ? new Date(trace.created).toISOString() : 
               new Date().toISOString(),
      sessionId: context.sessionId || trace.sessionId,
      workspaceId: context.workspaceId || trace.workspaceId,
      primaryGoal: context.primaryGoal || '',
      filesReferenced: this.getFilesReferenced(trace),
      type: trace.type
    };

    if (resultType === MemoryType.TOOL_CALL) {
      return {
        ...baseMetadata,
        toolUsed: metadata.tool?.id || trace.toolName,
        modeUsed: metadata.tool?.mode || trace.mode,
        toolCallId: trace.toolCallId,
        agent: metadata.tool?.agent || trace.agent,
        mode: metadata.tool?.mode || trace.mode,
        executionTime: trace.executionContext?.timing?.executionTime,
        success: metadata.outcome?.success ?? trace.metadata?.response?.success,
        errorMessage: metadata.outcome?.error?.message || trace.metadata?.response?.error?.message,
        affectedResources: trace.relationships?.affectedResources || metadata.legacy?.relatedFiles || []
      };
    }

    return {
      ...baseMetadata,
      toolUsed: metadata.tool?.id || metadata.legacy?.params?.tool || trace.metadata?.tool,
      modeUsed: metadata.tool?.mode || '',
      updated: trace.endTime ? new Date(trace.endTime).toISOString() : 
               trace.lastAccessed ? new Date(trace.lastAccessed).toISOString() : undefined
    };
  }

  private generateSearchContext(trace: any, query: string, resultType: MemoryType): any {
    const content = trace.content || trace.description || trace.name || '';
    const context = this.generateBasicContext(content, query);

    if (resultType === MemoryType.TOOL_CALL) {
      return this.enhanceToolCallContext(context, trace);
    }

    return context;
  }

  private generateBasicContext(content: string, query: string): any {
    const queryLower = query.toLowerCase();
    const contentLower = content.toLowerCase();
    const index = contentLower.indexOf(queryLower);
    
    if (index === -1) {
      return {
        before: '',
        match: content.substring(0, 100),
        after: ''
      };
    }
    
    const matchStart = index;
    const matchEnd = index + query.length;
    
    return {
      before: content.substring(Math.max(0, matchStart - 50), matchStart),
      match: content.substring(matchStart, matchEnd),
      after: content.substring(matchEnd, Math.min(content.length, matchEnd + 50))
    };
  }

  private enhanceToolCallContext(context: any, toolCallTrace: any): any {
    const toolMetadata = toolCallTrace.metadata?.tool;
    const toolInfo = toolMetadata ? `${toolMetadata.agent}.${toolMetadata.mode}` : `${toolCallTrace.agent}.${toolCallTrace.mode}`;
    const success = toolCallTrace.metadata?.outcome?.success ?? toolCallTrace.metadata?.response?.success;
    const statusInfo = success === false ? 'FAILED' : 'SUCCESS';
    const executionTime = toolCallTrace.executionContext?.timing?.executionTime;
    
    return {
      before: `[${toolInfo}] ${context.before}`,
      match: context.match,
      after: `${context.after} [${statusInfo}${executionTime ? ` - ${executionTime}ms` : ''}]`
    };
  }

  private deduplicateResults(results: RawMemoryResult[]): RawMemoryResult[] {
    const seen = new Set<string>();
    const unique: RawMemoryResult[] = [];
    
    for (const result of results) {
      const id = result.trace?.id;
      if (id && !seen.has(id)) {
        seen.add(id);
        unique.push(result);
      }
    }
    
    return unique;
  }

  private getFilesReferenced(trace: any): string[] {
    const metadata = trace.metadata || {};
    if (Array.isArray(metadata.input?.files) && metadata.input.files.length > 0) {
      return metadata.input.files;
    }

    if (Array.isArray(metadata.legacy?.relatedFiles) && metadata.legacy.relatedFiles.length > 0) {
      return metadata.legacy.relatedFiles;
    }

    if (Array.isArray(trace.relationships?.relatedFiles) && trace.relationships.relatedFiles.length > 0) {
      return trace.relationships.relatedFiles;
    }

    return [];
  }

  // Service access methods
  private getMemoryService(): MemoryService | undefined {
    try {
      const app: App = this.plugin.app;
      const plugin = getNexusPlugin(app) as NexusPlugin | null;
      if (plugin) {
        return plugin.getServiceIfReady<MemoryService>('memoryService') || undefined;
      }
      return undefined;
    } catch (error) {
      return undefined;
    }
  }


  private getWorkspaceService(): WorkspaceService | undefined {
    try {
      const app: App = this.plugin.app;
      const plugin = getNexusPlugin(app) as NexusPlugin | null;
      if (plugin) {
        return plugin.getServiceIfReady<WorkspaceService>('workspaceService') || undefined;
      }
      return undefined;
    } catch (error) {
      return undefined;
    }
  }
}
