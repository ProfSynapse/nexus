/**
 * Memory Search Processor
 *
 * Location: src/agents/searchManager/services/MemorySearchProcessor.ts
 * Purpose: Core search orchestrator across multiple memory types (traces, sessions,
 *          workspaces, conversations). Coordinates type-specific search strategies,
 *          enriches results with metadata and context highlights.
 * Used by: SearchMemoryTool for processing search requests and enriching results.
 *
 * Delegates to:
 *   - ServiceAccessors (runtime service resolution)
 *   - ConversationSearchStrategy (semantic vector search over conversation embeddings)
 */

import { Plugin, prepareFuzzySearch } from 'obsidian';
import {
  MemorySearchParameters,
  EnrichedMemorySearchResult,
  RawMemoryResult,
  MemorySearchContext,
  MemorySearchExecutionOptions,
  ValidationResult,
  MemoryProcessorConfiguration,
  MemoryResultMetadata,
  SearchResultContext,
  SearchMethod,
  MemoryType
} from '../../../types/memory/MemorySearchTypes';
import { WorkspaceService, GLOBAL_WORKSPACE_ID } from '../../../services/WorkspaceService';
import { IStorageAdapter } from '../../../database/interfaces/IStorageAdapter';
import { MemoryTraceData } from '../../../types/storage/HybridStorageTypes';
import { ServiceAccessors } from './ServiceAccessors';
import { ConversationSearchStrategy } from './ConversationSearchStrategy';

/**
 * Metadata about which memory types were actually searched, unavailable, or failed.
 * Used by the SearchMemoryTool to provide actionable feedback when results are
 * empty or incomplete.
 */
export interface SearchMetadata {
  typesSearched: string[];
  typesUnavailable: string[];
  typesFailed: string[];
}

/**
 * Return type from process() that bundles enriched results with search metadata.
 */
export interface SearchProcessResult {
  results: EnrichedMemorySearchResult[];
  metadata: SearchMetadata;
}

export interface MemorySearchProcessorInterface {
  process(params: MemorySearchParameters): Promise<SearchProcessResult>;
  validateParameters(params: MemorySearchParameters): ValidationResult;
  executeSearch(query: string, options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]>;
  enrichResults(results: RawMemoryResult[], context: MemorySearchContext): Promise<EnrichedMemorySearchResult[]>;
  getConfiguration(): MemoryProcessorConfiguration;
  updateConfiguration(config: Partial<MemoryProcessorConfiguration>): Promise<void>;
}

export class MemorySearchProcessor implements MemorySearchProcessorInterface {
  private configuration: MemoryProcessorConfiguration;
  private workspaceService?: WorkspaceService;
  private storageAdapter?: IStorageAdapter;
  private serviceAccessors: ServiceAccessors;
  private conversationSearch: ConversationSearchStrategy;

  constructor(
    plugin: Plugin,
    config?: Partial<MemoryProcessorConfiguration>,
    workspaceService?: WorkspaceService,
    storageAdapter?: IStorageAdapter
  ) {
    this.workspaceService = workspaceService;
    this.storageAdapter = storageAdapter;
    this.serviceAccessors = new ServiceAccessors(plugin, storageAdapter);
    this.conversationSearch = new ConversationSearchStrategy({
      getEmbeddingService: () => this.serviceAccessors.getEmbeddingService(),
      getMessageRepository: () => this.serviceAccessors.getMessageRepository()
    });
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
   * Main processing entry point.
   * Returns enriched results bundled with metadata about which memory types
   * were searched, unavailable, or failed during execution.
   */
  async process(params: MemorySearchParameters): Promise<SearchProcessResult> {
    const validation = this.validateParameters(params);
    if (!validation.isValid) {
      throw new Error(`Invalid parameters: ${validation.errors.join(', ')}`);
    }

    const context: MemorySearchContext = {
      params,
      timestamp: new Date()
    };

    const searchOptions = this.buildSearchOptions(params);
    const { rawResults, metadata } = await this.executeSearchWithMetadata(params.query, searchOptions);
    const results = await this.enrichResults(rawResults, context);

    return { results, metadata };
  }

  /**
   * Validates search parameters
   */
  validateParameters(params: MemorySearchParameters): ValidationResult {
    const errors: string[] = [];

    if (!params.query || params.query.trim().length === 0) {
      errors.push('Query parameter is required and cannot be empty');
    }

    if (params.limit !== undefined) {
      if (params.limit < 1) {
        errors.push('Limit must be positive');
      }
      if (params.limit > this.configuration.maxLimit) {
        errors.push(`Limit cannot exceed ${this.configuration.maxLimit}`);
      }
    }

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

    const memoryTypes = options.memoryTypes || ['traces', 'toolCalls', 'sessions', 'states', 'workspaces', 'conversations'];
    const limit = options.limit || this.configuration.defaultLimit;

    if (memoryTypes.includes('traces')) {
      searchPromises.push(this.searchLegacyTraces(query, options));
    }

    if (memoryTypes.includes('toolCalls')) {
      searchPromises.push(this.searchToolCallTraces());
    }

    if (memoryTypes.includes('sessions')) {
      searchPromises.push(this.searchSessions(query, options));
    }

    if (memoryTypes.includes('states')) {
      searchPromises.push(this.searchStates(query, options));
    }

    if (memoryTypes.includes('workspaces')) {
      searchPromises.push(this.searchWorkspaces(query, options));
    }

    if (memoryTypes.includes('conversations')) {
      searchPromises.push(this.conversationSearch.search(query, options, this.configuration));
    }

    const searchResults = await Promise.allSettled(searchPromises);

    for (const result of searchResults) {
      if (result.status === 'fulfilled') {
        results.push(...result.value);
      } else {
        console.error('[MemorySearchProcessor] Search error:', result.reason);
      }
    }

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
        const enriched = this.enrichSingleResult(result, context);
        if (enriched) {
          enrichedResults.push(enriched);
        }
      } catch (error) {
        console.error('[MemorySearchProcessor] Error enriching results:', error);
      }
    }

    return enrichedResults;
  }

  getConfiguration(): MemoryProcessorConfiguration {
    return { ...this.configuration };
  }

  async updateConfiguration(config: Partial<MemoryProcessorConfiguration>): Promise<void> {
    this.configuration = { ...this.configuration, ...config };
  }

  // ---------------------------------------------------------------------------
  // Private: search options builder
  // ---------------------------------------------------------------------------

  private buildSearchOptions(params: MemorySearchParameters): MemorySearchExecutionOptions {
    return {
      workspaceId: params.workspaceId || params.workspace,
      sessionId: params.sessionId,
      limit: params.limit || this.configuration.defaultLimit,
      toolCallFilters: params.toolCallFilters,
      memoryTypes: params.memoryTypes,
      windowSize: params.windowSize
    };
  }

  // ---------------------------------------------------------------------------
  // Private: metadata-aware search execution
  // ---------------------------------------------------------------------------

  /**
   * Wraps executeSearch logic with metadata tracking for which types were
   * searched, unavailable, or failed. Used by process() to provide actionable
   * feedback alongside results.
   */
  private async executeSearchWithMetadata(query: string, options: MemorySearchExecutionOptions): Promise<{ rawResults: RawMemoryResult[], metadata: SearchMetadata }> {
    const metadata: SearchMetadata = {
      typesSearched: [],
      typesUnavailable: [],
      typesFailed: []
    };

    const results: RawMemoryResult[] = [];
    const searchPromises: Promise<RawMemoryResult[]>[] = [];
    const typeNames: string[] = [];

    const memoryTypes = options.memoryTypes || ['traces', 'toolCalls', 'sessions', 'states', 'workspaces', 'conversations'];
    const limit = options.limit || this.configuration.defaultLimit;

    if (memoryTypes.includes('traces')) {
      searchPromises.push(this.searchLegacyTraces(query, options));
      typeNames.push('traces');
      metadata.typesSearched.push('traces');
    }

    if (memoryTypes.includes('toolCalls')) {
      searchPromises.push(this.searchToolCallTraces());
      typeNames.push('toolCalls');
      metadata.typesSearched.push('toolCalls');
    }

    if (memoryTypes.includes('sessions')) {
      searchPromises.push(this.searchSessions(query, options));
      typeNames.push('sessions');
      metadata.typesSearched.push('sessions');
    }

    if (memoryTypes.includes('states')) {
      searchPromises.push(this.searchStates(query, options));
      typeNames.push('states');
      metadata.typesSearched.push('states');
    }

    if (memoryTypes.includes('workspaces')) {
      searchPromises.push(this.searchWorkspaces(query, options));
      typeNames.push('workspaces');
      metadata.typesSearched.push('workspaces');
    }

    if (memoryTypes.includes('conversations')) {
      if (this.conversationSearch.isAvailable()) {
        searchPromises.push(this.conversationSearch.search(query, options, this.configuration));
        typeNames.push('conversations');
        metadata.typesSearched.push('conversations');
      } else {
        metadata.typesUnavailable.push('conversations');
      }
    }

    const searchResults = await Promise.allSettled(searchPromises);

    for (let i = 0; i < searchResults.length; i++) {
      if (searchResults[i].status === 'fulfilled') {
        results.push(...(searchResults[i] as PromiseFulfilledResult<RawMemoryResult[]>).value);
      } else {
        console.error('[MemorySearchProcessor] Search error:', (searchResults[i] as PromiseRejectedResult).reason);
        const failedType = typeNames[i];
        metadata.typesFailed.push(failedType);
        const idx = metadata.typesSearched.indexOf(failedType);
        if (idx !== -1) metadata.typesSearched.splice(idx, 1);
      }
    }

    results.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    return { rawResults: results.slice(0, limit), metadata };
  }

  // ---------------------------------------------------------------------------
  // Private: per-type search methods
  // ---------------------------------------------------------------------------

  private async searchLegacyTraces(query: string, options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]> {
    const workspaceId = options.workspaceId || GLOBAL_WORKSPACE_ID;

    if (this.storageAdapter) {
      try {
        const result = await this.storageAdapter.searchTraces(workspaceId, query, options.sessionId);
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
          similarity: 1.0
        }));
      } catch (error) {
        console.error('[MemorySearchProcessor] Error searching traces via storage adapter:', error);
        return [];
      }
    }

    const workspaceService = this.workspaceService || this.serviceAccessors.getWorkspaceService();
    if (!workspaceService) {
      return [];
    }

    try {
      const workspace = await workspaceService.getWorkspace(workspaceId);
      if (!workspace) {
        return [];
      }

      const fuzzySearch = prepareFuzzySearch(query.toLowerCase());
      const results: RawMemoryResult[] = [];

      if (workspace.sessions) {
        for (const [sessionId, session] of Object.entries(workspace.sessions)) {
          const traces = Object.values(session.memoryTraces || {});
          for (const trace of traces) {
            const traceJSON = JSON.stringify(trace);
            const match = fuzzySearch(traceJSON);
            if (match) {
              const normalizedScore = Math.max(0, Math.min(1, 1 + (match.score / 100)));
              results.push({
                trace: { ...trace, workspaceId, sessionId },
                similarity: normalizedScore
              });
            }
          }
        }
      }

      results.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
      return options.limit ? results.slice(0, options.limit) : results;
    } catch (error) {
      console.error('[MemorySearchProcessor] Error searching legacy traces:', error);
      return [];
    }
  }

  private async searchToolCallTraces(): Promise<RawMemoryResult[]> {
    return [];
  }

  private async searchSessions(query: string, options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]> {
    const memoryService = this.serviceAccessors.getMemoryService();
    if (!memoryService) return [];

    try {
      const sessionsResult = await memoryService.getSessions(options.workspaceId || GLOBAL_WORKSPACE_ID);
      const queryLower = query.toLowerCase();
      const results: RawMemoryResult[] = [];

      for (const session of sessionsResult.items) {
        let score = 0;
        if ((session.name || '').toLowerCase().includes(queryLower)) score += 0.9;
        if (session.description?.toLowerCase().includes(queryLower)) score += 0.8;
        if (score > 0) {
          results.push({ trace: session, similarity: score });
        }
      }
      return results;
    } catch (error) {
      console.error('[MemorySearchProcessor] Error searching sessions:', error);
      return [];
    }
  }

  private async searchStates(query: string, options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]> {
    const memoryService = this.serviceAccessors.getMemoryService();
    if (!memoryService) return [];

    try {
      const statesResult = await memoryService.getStates(options.workspaceId || GLOBAL_WORKSPACE_ID, options.sessionId);
      const queryLower = query.toLowerCase();
      const results: RawMemoryResult[] = [];

      for (const state of statesResult.items) {
        let score = 0;
        if (state.name.toLowerCase().includes(queryLower)) score += 0.9;
        if (score > 0) {
          results.push({ trace: state, similarity: score });
        }
      }
      return results;
    } catch (error) {
      console.error('[MemorySearchProcessor] Error searching states:', error);
      return [];
    }
  }

  private async searchWorkspaces(query: string, options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]> {
    const workspaceService = this.serviceAccessors.getWorkspaceService();
    if (!workspaceService) return [];

    try {
      const workspaces = await workspaceService.listWorkspaces();
      const queryLower = query.toLowerCase();
      const results: RawMemoryResult[] = [];

      for (const workspace of workspaces) {
        let score = 0;
        if (workspace.name.toLowerCase().includes(queryLower)) score += 0.9;
        if (workspace.description?.toLowerCase().includes(queryLower)) score += 0.8;
        if (score > 0) {
          results.push({ trace: workspace, similarity: score });
        }
      }
      return results;
    } catch (error) {
      console.error('[MemorySearchProcessor] Error searching workspaces:', error);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private: result enrichment
  // ---------------------------------------------------------------------------

  private enrichSingleResult(result: RawMemoryResult, context: MemorySearchContext): EnrichedMemorySearchResult | null {
    const trace = result.trace;
    const query = context.params.query;

    try {
      const resultType = this.determineResultType(trace);
      const highlight = this.generateHighlight(trace, query);
      const metadata = this.buildMetadata(trace, resultType);
      const searchContext = this.generateSearchContext(trace, query, resultType);

      return {
        type: resultType,
        id: trace.id,
        highlight,
        metadata,
        context: searchContext,
        score: result.similarity || 0,
        _rawTrace: trace
      };
    } catch (error) {
      console.error('[MemorySearchProcessor] Failed to enrich result:', { error, traceId: trace?.id });
      return null;
    }
  }

  private determineResultType(trace: Record<string, unknown>): MemoryType {
    if (trace.type === 'conversation' && 'conversationId' in trace) return MemoryType.CONVERSATION;
    if ('toolCallId' in trace && trace.toolCallId) return MemoryType.TOOL_CALL;
    if ('name' in trace && 'startTime' in trace && trace.startTime !== undefined) return MemoryType.SESSION;
    if ('name' in trace && 'timestamp' in trace && trace.timestamp !== undefined) return MemoryType.STATE;
    if ('name' in trace && 'created' in trace && trace.created !== undefined) return MemoryType.WORKSPACE;
    return MemoryType.TRACE;
  }

  private generateHighlight(trace: Record<string, unknown>, query: string): string {
    const maxLength = 200;
    const content = (trace.content || trace.description || trace.name || '') as string;
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

  private buildMetadata(trace: Record<string, unknown>, resultType: MemoryType): MemoryResultMetadata {
    const metadata = (trace.metadata || {}) as Record<string, unknown>;
    const context = (metadata.context || {}) as Record<string, unknown>;
    const baseMetadata: MemoryResultMetadata = {
      created: trace.timestamp ? new Date(trace.timestamp as number).toISOString() :
               trace.startTime ? new Date(trace.startTime as number).toISOString() :
               trace.created ? new Date(trace.created as number).toISOString() :
               new Date().toISOString(),
      sessionId: (context.sessionId || trace.sessionId) as string | undefined,
      workspaceId: (context.workspaceId || trace.workspaceId) as string | undefined,
      primaryGoal: (context.primaryGoal || '') as string,
      filesReferenced: this.getFilesReferenced(trace),
      type: trace.type as string | undefined
    };

    if (resultType === MemoryType.TOOL_CALL) {
      const tool = metadata.tool as Record<string, unknown> | undefined;
      const outcome = metadata.outcome as Record<string, unknown> | undefined;
      const response = metadata.response as Record<string, unknown> | undefined;
      const execCtx = trace.executionContext as Record<string, unknown> | undefined;
      const timing = execCtx?.timing as Record<string, unknown> | undefined;
      const rels = trace.relationships as Record<string, unknown> | undefined;
      const legacy = metadata.legacy as Record<string, unknown> | undefined;
      return {
        ...baseMetadata,
        toolUsed: (tool?.id || trace.toolName) as string | undefined,
        modeUsed: (tool?.mode || trace.mode) as string | undefined,
        toolCallId: trace.toolCallId as string | undefined,
        agent: (tool?.agent || trace.agent) as string | undefined,
        mode: (tool?.mode || trace.mode) as string | undefined,
        executionTime: timing?.executionTime as number | undefined,
        success: (outcome?.success ?? response?.success) as boolean | undefined,
        errorMessage: ((outcome?.error as Record<string, unknown> | undefined)?.message ||
                      (response?.error as Record<string, unknown> | undefined)?.message) as string | undefined,
        affectedResources: (rels?.affectedResources || legacy?.relatedFiles || []) as string[]
      };
    }

    const tool = metadata.tool as Record<string, unknown> | undefined;
    const legacy = metadata.legacy as Record<string, unknown> | undefined;
    const legacyParams = legacy?.params as Record<string, unknown> | undefined;
    const traceMeta = trace.metadata as Record<string, unknown> | undefined;
    return {
      ...baseMetadata,
      toolUsed: (tool?.id || legacyParams?.tool || traceMeta?.tool) as string | undefined,
      modeUsed: (tool?.mode || '') as string,
      updated: trace.endTime ? new Date(trace.endTime as number).toISOString() :
               trace.lastAccessed ? new Date(trace.lastAccessed as number).toISOString() : undefined
    };
  }

  private generateSearchContext(trace: Record<string, unknown>, query: string, resultType: MemoryType): SearchResultContext {
    const content = (trace.content || trace.description || trace.name || '') as string;
    const ctx = this.generateBasicContext(content, query);
    if (resultType === MemoryType.TOOL_CALL) {
      return this.enhanceToolCallContext(ctx, trace);
    }
    return ctx;
  }

  private generateBasicContext(content: string, query: string): SearchResultContext {
    const queryLower = query.toLowerCase();
    const contentLower = content.toLowerCase();
    const index = contentLower.indexOf(queryLower);

    if (index === -1) {
      return { before: '', match: content.substring(0, 100), after: '' };
    }

    return {
      before: content.substring(Math.max(0, index - 50), index),
      match: content.substring(index, index + query.length),
      after: content.substring(index + query.length, Math.min(content.length, index + query.length + 50))
    };
  }

  private enhanceToolCallContext(ctx: SearchResultContext, trace: Record<string, unknown>): SearchResultContext {
    const meta = trace.metadata as Record<string, unknown> | undefined;
    const toolMeta = meta?.tool as Record<string, unknown> | undefined;
    const toolInfo = toolMeta ? `${toolMeta.agent}.${toolMeta.mode}` : `${trace.agent}.${trace.mode}`;
    const outcome = meta?.outcome as Record<string, unknown> | undefined;
    const response = meta?.response as Record<string, unknown> | undefined;
    const success = outcome?.success ?? response?.success;
    const statusInfo = success === false ? 'FAILED' : 'SUCCESS';
    const execCtx = trace.executionContext as Record<string, unknown> | undefined;
    const timing = execCtx?.timing as Record<string, unknown> | undefined;
    const executionTime = timing?.executionTime;

    return {
      before: `[${toolInfo}] ${ctx.before}`,
      match: ctx.match,
      after: `${ctx.after} [${statusInfo}${executionTime ? ` - ${executionTime}ms` : ''}]`
    };
  }

  private getFilesReferenced(trace: Record<string, unknown>): string[] {
    const metadata = (trace.metadata || {}) as Record<string, unknown>;
    const input = metadata.input as Record<string, unknown> | undefined;
    if (Array.isArray(input?.files) && input.files.length > 0) {
      return input.files as string[];
    }
    const legacy = metadata.legacy as Record<string, unknown> | undefined;
    if (Array.isArray(legacy?.relatedFiles) && legacy.relatedFiles.length > 0) {
      return legacy.relatedFiles as string[];
    }
    const rels = trace.relationships as Record<string, unknown> | undefined;
    if (Array.isArray(rels?.relatedFiles) && rels.relatedFiles.length > 0) {
      return rels.relatedFiles as string[];
    }
    return [];
  }
}
