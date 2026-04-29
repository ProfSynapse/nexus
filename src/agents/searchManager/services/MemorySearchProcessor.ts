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
  MemorySearchTraceLike,
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
import type { MemoryService } from '../../memoryManager/services/MemoryService';
import { ServiceAccessors, StorageAdapterResolver } from './ServiceAccessors';
import { ConversationSearchStrategy } from './ConversationSearchStrategy';
import { splitTopLevelSegments, tokenizeWithMeta } from '../../toolManager/services/ToolCliNormalizer';

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
  enrichResults(results: RawMemoryResult[], context: MemorySearchContext): EnrichedMemorySearchResult[];
  getConfiguration(): MemoryProcessorConfiguration;
  updateConfiguration(config: Partial<MemoryProcessorConfiguration>): void;
}

export class MemorySearchProcessor implements MemorySearchProcessorInterface {
  private configuration: MemoryProcessorConfiguration;
  private workspaceService?: WorkspaceService;
  private storageAdapter?: StorageAdapterResolver;
  private memoryService?: MemoryService;
  private serviceAccessors: ServiceAccessors;
  private conversationSearch: ConversationSearchStrategy;

  constructor(
    plugin: Plugin,
    config?: Partial<MemoryProcessorConfiguration>,
    workspaceService?: WorkspaceService,
    storageAdapter?: StorageAdapterResolver,
    memoryService?: MemoryService
  ) {
    this.workspaceService = workspaceService;
    this.storageAdapter = storageAdapter;
    this.memoryService = memoryService;
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
    const results = this.enrichResults(rawResults, context);

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
  enrichResults(results: RawMemoryResult[], context: MemorySearchContext): EnrichedMemorySearchResult[] {
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

  updateConfiguration(config: Partial<MemoryProcessorConfiguration>): void {
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
    const storageAdapter = this.getStorageAdapter();

    if (storageAdapter) {
      try {
        const [searchedTraces, recentTraces] = await Promise.all([
          storageAdapter.searchTraces(workspaceId, query, options.sessionId),
          storageAdapter.getTraces(workspaceId, options.sessionId, { pageSize: options.limit || this.configuration.defaultLimit })
            .then(result => result.items)
            .catch(() => [])
        ]);
        const traces = this.mergeTracesById(searchedTraces, recentTraces);
        return this.buildTraceResults(traces, query);
      } catch (error) {
        console.error('[MemorySearchProcessor] Error searching traces via storage adapter:', error);
        return [];
      }
    }

    const memoryService = this.memoryService || this.serviceAccessors.getMemoryService();
    if (memoryService) {
      try {
        const tracesResult = await memoryService.getMemoryTraces(workspaceId, options.sessionId, {
          pageSize: options.limit || this.configuration.defaultLimit
        });
        return this.buildTraceResults(
          tracesResult.items.map(trace => this.normalizeTraceData(trace as unknown as Record<string, unknown>, workspaceId, options.sessionId)),
          query
        );
      } catch (error) {
        console.error('[MemorySearchProcessor] Error searching traces via memory service:', error);
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
                trace: { ...trace, workspaceId, sessionId } as unknown as RawMemoryResult['trace'],
                similarity: normalizedScore
              } as RawMemoryResult);
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

  private getStorageAdapter(): IStorageAdapter | undefined {
    return typeof this.storageAdapter === 'function'
      ? this.storageAdapter()
      : this.storageAdapter;
  }

  private searchToolCallTraces(): Promise<RawMemoryResult[]> {
    return Promise.resolve([]);
  }

  private buildTraceResults(traces: MemoryTraceData[], query: string): RawMemoryResult[] {
    const queryLower = query.toLowerCase();
    return traces.flatMap((trace: MemoryTraceData) => {
      const expanded = this.expandUseToolsTraceMatches(trace, query);
      const traceCandidates = expanded.length > 0 ? expanded : [{
        id: trace.id,
        workspaceId: trace.workspaceId,
        sessionId: trace.sessionId,
        timestamp: trace.timestamp,
        type: trace.type || 'generic',
        content: trace.content,
        metadata: trace.metadata
      }];

      return traceCandidates
        .filter(expandedTrace => expanded.length > 0 || this.traceMatchesQuery(expandedTrace, queryLower))
        .map(expandedTrace => ({
          trace: expandedTrace as unknown as RawMemoryResult['trace'],
          similarity: 1.0
        } as RawMemoryResult));
    });
  }

  private normalizeTraceData(
    trace: Record<string, unknown>,
    fallbackWorkspaceId: string,
    fallbackSessionId?: string
  ): MemoryTraceData {
    return {
      id: typeof trace.id === 'string' ? trace.id : '',
      workspaceId: typeof trace.workspaceId === 'string' ? trace.workspaceId : fallbackWorkspaceId,
      sessionId: typeof trace.sessionId === 'string' ? trace.sessionId : fallbackSessionId || '',
      timestamp: typeof trace.timestamp === 'number' ? trace.timestamp : Date.now(),
      type: typeof trace.type === 'string' ? trace.type : undefined,
      content: typeof trace.content === 'string' ? trace.content : '',
      metadata: trace.metadata && typeof trace.metadata === 'object' && !Array.isArray(trace.metadata)
        ? trace.metadata as Record<string, unknown>
        : undefined
    };
  }

  private mergeTracesById(...traceLists: MemoryTraceData[][]): MemoryTraceData[] {
    const traces = new Map<string, MemoryTraceData>();
    for (const traceList of traceLists) {
      for (const trace of traceList) {
        traces.set(trace.id, trace);
      }
    }
    return Array.from(traces.values());
  }

  private traceMatchesQuery(trace: MemoryTraceData, queryLower: string): boolean {
    return [
      trace.content,
      trace.type,
      JSON.stringify(trace.metadata || {})
    ].some(value => typeof value === 'string' && value.toLowerCase().includes(queryLower));
  }

  private expandUseToolsTraceMatches(trace: MemoryTraceData, query: string): MemoryTraceData[] {
    const metadata = trace.metadata;
    const tool = metadata?.tool as Record<string, unknown> | undefined;
    if (tool?.mode !== 'useTools' && tool?.mode !== 'useTool') {
      return [];
    }

    const legacy = metadata?.legacy as Record<string, unknown> | undefined;
    const result = legacy?.result as Record<string, unknown> | undefined;
    const data = result?.data as Record<string, unknown> | undefined;
    const results = Array.isArray(data?.results)
      ? data.results
      : result?.agent && result.tool
        ? [result]
        : [];

    if (results.length === 0) {
      return [];
    }

    const queryLower = query.toLowerCase();
    const toolString = this.extractUseToolsCommand(metadata);
    const segments = toolString ? splitTopLevelSegments(toolString) : [];

    return results
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      .map((item, index) => {
        const agent = typeof item.agent === 'string' ? item.agent : 'unknown';
        const mode = typeof item.tool === 'string' ? item.tool : 'unknown';
        const content = this.formatUseToolsResultContent(item, segments[index]);
        return {
          ...trace,
          id: `${trace.id}:${index}`,
          content,
          metadata: {
            ...metadata,
            tool: {
              id: `${agent}_${mode}`,
              agent,
              mode
            }
          }
        } satisfies MemoryTraceData;
      })
      .filter(item => {
        const tool = item.metadata?.tool as Record<string, unknown> | undefined;
        return [
          item.content,
          tool?.id,
          tool?.agent,
          tool?.mode
        ].some(value => typeof value === 'string' && value.toLowerCase().includes(queryLower));
      });
  }

  private extractUseToolsCommand(metadata: Record<string, unknown> | undefined): string | undefined {
    const input = metadata?.input as Record<string, unknown> | undefined;
    const inputArgs = input?.arguments as Record<string, unknown> | undefined;
    if (typeof inputArgs?.tool === 'string') {
      return inputArgs.tool;
    }

    const legacy = metadata?.legacy as Record<string, unknown> | undefined;
    const params = legacy?.params as Record<string, unknown> | undefined;
    return typeof params?.tool === 'string' ? params.tool : undefined;
  }

  private formatUseToolsResultContent(result: Record<string, unknown>, segment?: string): string {
    const agent = typeof result.agent === 'string' ? result.agent : 'unknown';
    const tool = typeof result.tool === 'string' ? result.tool : 'unknown';
    const params = result.params as Record<string, unknown> | undefined;
    const segmentArgs = segment ? this.parseCliSegmentArgs(segment) : {};
    const path = params && typeof params.path === 'string'
      ? params.path
      : typeof segmentArgs.path === 'string'
        ? segmentArgs.path
        : undefined;
    const query = params && typeof params.query === 'string'
      ? params.query
      : typeof segmentArgs.query === 'string'
        ? segmentArgs.query
        : undefined;
    const name = params && typeof params.name === 'string'
      ? params.name
      : typeof segmentArgs.name === 'string'
        ? segmentArgs.name
        : undefined;
    const target = path || query || name || (typeof segmentArgs._positional0 === 'string' ? segmentArgs._positional0 : undefined);
    const normalizedAgent = agent.replace(/[-_\s]/g, '').toLowerCase();
    const normalizedTool = tool.replace(/[-_\s]/g, '').toLowerCase();
    const activity = normalizedAgent === 'contentmanager' || normalizedAgent === 'content'
      ? normalizedTool === 'write'
        ? target ? `Wrote ${target}` : 'Wrote file'
        : normalizedTool === 'replace'
          ? target ? `Updated ${target}` : 'Updated file'
          : normalizedTool === 'read'
            ? target ? `Read ${target}` : 'Read file'
            : undefined
      : normalizedAgent === 'storagemanager' || normalizedAgent === 'storage'
        ? normalizedTool === 'createfolder'
          ? target ? `Created folder ${target}` : 'Created folder'
          : normalizedTool === 'move'
            ? target ? `Moved ${target}` : 'Moved item'
            : undefined
      : undefined;
    const parts = [activity || `${agent}.${tool}`];

    if (target && !parts[0].includes(target)) {
      parts.push(target);
    }

    if (result.success === false) {
      parts.push('failed');
    }

    return parts.join(' ');
  }

  private parseCliSegmentArgs(segment: string): Record<string, unknown> {
    const tokens = tokenizeWithMeta(segment);
    const args: Record<string, unknown> = {};
    let positional = 0;

    for (let index = 2; index < tokens.length; index += 1) {
      const token = tokens[index];
      const isFlag = !token.wasQuoted && token.value.startsWith('--');
      if (isFlag) {
        const key = token.value.slice(2);
        const nextToken = tokens[index + 1];
        if (nextToken && (nextToken.wasQuoted || !nextToken.value.startsWith('--'))) {
          args[key] = nextToken.value;
          index += 1;
        } else {
          args[key] = true;
        }
        continue;
      }

      args[`_positional${positional}`] = token.value;
      if (positional === 0 && args.path === undefined) {
        args.path = token.value;
      }
      positional += 1;
    }

    return args;
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
          results.push({ trace: session as unknown as RawMemoryResult['trace'], similarity: score } as RawMemoryResult);
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
          results.push({ trace: state as unknown as RawMemoryResult['trace'], similarity: score } as RawMemoryResult);
        }
      }
      return results;
    } catch (error) {
      console.error('[MemorySearchProcessor] Error searching states:', error);
      return [];
    }
  }

  private async searchWorkspaces(query: string, _options: MemorySearchExecutionOptions): Promise<RawMemoryResult[]> {
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
          results.push({ trace: workspace as unknown as RawMemoryResult['trace'], similarity: score } as RawMemoryResult);
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
    const trace = result.trace as unknown as MemorySearchTraceLike;
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
        _rawTrace: trace as unknown as RawMemoryResult['trace']
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
    const toolInfo = toolMeta
      ? `${toDisplayString(toolMeta.agent)}.${toDisplayString(toolMeta.mode)}`
      : `${toDisplayString(trace.agent)}.${toDisplayString(trace.mode)}`;
    const outcome = meta?.outcome as Record<string, unknown> | undefined;
    const response = meta?.response as Record<string, unknown> | undefined;
    const success = outcome?.success ?? response?.success;
    const statusInfo = success === false ? 'FAILED' : 'SUCCESS';
    const execCtx = trace.executionContext as Record<string, unknown> | undefined;
    const timing = execCtx?.timing as Record<string, unknown> | undefined;
    const executionTime = timing?.executionTime;
    const executionTimeText = executionTime === undefined ? '' : ` - ${toDisplayString(executionTime)}ms`;

    return {
      before: `[${toolInfo}] ${ctx.before}`,
      match: ctx.match,
      after: `${ctx.after} [${statusInfo}${executionTimeText}]`
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

function toDisplayString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[Object]';
    }
  }

  return '';
}
