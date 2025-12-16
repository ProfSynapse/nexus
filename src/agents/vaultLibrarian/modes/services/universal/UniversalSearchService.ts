/**
 * UniversalSearchService - Refactored following SOLID principles
 * Orchestrates specialized search services for unified search functionality
 */

import { Plugin, TFile } from 'obsidian';
import { isGlobPattern, globToRegex, normalizePath } from '../../../../../utils/pathUtils';
import { MemoryService } from "../../../../memoryManager/services/MemoryService";
import { WorkspaceService } from '../../../../../services/WorkspaceService';
import { GraphOperations } from '../../../../../database/utils/graph/GraphOperations';
type MetadataSearchCriteria = any;
import { 
  UniversalSearchParams, 
  UniversalSearchResult, 
  UniversalSearchResultItem 
} from '../../../types';

// Import specialized services
import { QueryParser } from './query/QueryParser';
import { ContentSearchStrategy } from './strategies/ContentSearchStrategy';
import { FileSearchStrategy } from './strategies/FileSearchStrategy';
import { MetadataSearchStrategy } from './strategies/MetadataSearchStrategy';
import { ResultConsolidator, ConsolidatedSearchResult } from './results/ResultConsolidator';
import { ResultFormatter } from './results/ResultFormatter';
import { ServiceInitializer } from './initialization/ServiceInitializer';
import { globalValidationErrorMonitor, ValidationErrorMonitor } from './validation/ValidationErrorMonitor';

/**
 * Refactored UniversalSearchService following SOLID principles
 * Orchestrates specialized search services for unified search functionality
 */
export class UniversalSearchService {
  private plugin: Plugin;
  private graphOperations: GraphOperations;
  
  // Composed services following Dependency Injection principle
  private serviceInitializer: ServiceInitializer;
  private queryParser: QueryParser;
  private contentSearchStrategy: ContentSearchStrategy;
  private fileSearchStrategy: FileSearchStrategy;
  private metadataSearchStrategy: MetadataSearchStrategy;
  private resultConsolidator: ResultConsolidator;
  private resultFormatter: ResultFormatter;
  
  // Service references
  private metadataSearchService?: any;
  private memoryService?: MemoryService;
  private workspaceService?: WorkspaceService;

  constructor(
    plugin: Plugin,
    memoryService?: MemoryService,
    workspaceService?: WorkspaceService
  ) {
    this.plugin = plugin;
    this.graphOperations = new GraphOperations();
    
    // Initialize specialized services
    this.serviceInitializer = new ServiceInitializer(plugin);
    this.queryParser = new QueryParser();
    this.contentSearchStrategy = new ContentSearchStrategy();
    this.fileSearchStrategy = new FileSearchStrategy(plugin);
    this.metadataSearchStrategy = new MetadataSearchStrategy(plugin, null);
    this.resultConsolidator = new ResultConsolidator();
    this.resultFormatter = new ResultFormatter();
    
    // Store provided services
    this.memoryService = memoryService;
    this.workspaceService = workspaceService;
    
    // Initialize services
    this.initializeServices();
  }

  /**
   * Filter files by paths (supporting glob patterns)
   */
  private filterFilesByPaths(files: TFile[], paths: string[]): TFile[] {
    const globPatterns = paths.filter(p => isGlobPattern(p)).map(p => globToRegex(p));
    const literalPaths = paths
      .filter(p => !isGlobPattern(p))
      .map(p => normalizePath(p));
    
    return files.filter(file => {
      const matchesLiteral = literalPaths.some(path => {
        // Empty path (from "/") matches everything
        if (path === '') return true;
        return file.path.startsWith(path);
      });
      const matchesGlob = globPatterns.some(regex => regex.test(file.path));
      return matchesLiteral || matchesGlob;
    });
  }

  /**
   * Initialize all services
   */
  private async initializeServices(): Promise<void> {
    try {
      const result = await this.serviceInitializer.initializeServices({
        memoryService: this.memoryService,
        workspaceService: this.workspaceService
      });

      if (result.success && result.services) {
        this.metadataSearchService = result.services.metadataSearchService;
        
        // Update search strategies (no services needed for keyword-only search)
        this.contentSearchStrategy.updateServices();
        
        this.metadataSearchStrategy = new MetadataSearchStrategy(
          this.plugin,
          this.metadataSearchService
        );
      }
    } catch (error) {
    }
  }

  /**
   * Populate hybrid search indexes
   */
  async populateHybridSearchIndexes(): Promise<void> {
    try {
      const result = await this.serviceInitializer.populateHybridSearchIndexes();
      if (!result.success) {
      }
    } catch (error) {
    }
  }

  /**
   * Execute consolidated search (returns consolidated results)
   */
  async executeConsolidatedSearch(params: UniversalSearchParams): Promise<ConsolidatedSearchResult[]> {
    try {
      const startTime = performance.now();
      const { query, limit = 10 } = params;


      // 1. Parse query
      const parseStart = performance.now();
      const parseResult = this.queryParser.parseSearchQuery(query);
      const parseTime = performance.now() - parseStart;
      
      if (!parseResult.success) {
        throw new Error(parseResult.error);
      }

      const parsedQuery = parseResult.parsed!;

      // 2. Filter files by metadata and paths
      let filteredFiles: TFile[] | undefined;

      // Apply path filtering if paths are provided
      if (params.paths && params.paths.length > 0) {
        const allFiles = this.plugin.app.vault.getMarkdownFiles();
        filteredFiles = this.filterFilesByPaths(allFiles, params.paths);
      }

      if (parsedQuery.tags.length > 0 || parsedQuery.properties.length > 0) {
        const filterStart = performance.now();
        
        const criteria: MetadataSearchCriteria = {
          tags: parsedQuery.tags,
          properties: parsedQuery.properties,
          matchAll: true
        };
        
        if (this.metadataSearchService) {
          const metadataFiles = await this.metadataSearchService.getFilesMatchingMetadata(criteria);
          
          if (filteredFiles) {
            // Intersect with existing filtered files
            const metadataPathSet = new Set(metadataFiles.map((f: TFile) => f.path));
            filteredFiles = filteredFiles.filter(f => metadataPathSet.has(f.path));
          } else {
            filteredFiles = metadataFiles;
          }
          const filterTime = performance.now() - filterStart;
        }
      }

      // 3. Search content
      const contentStart = performance.now();
      const contentResult = await this.contentSearchStrategy.searchContent(
        parsedQuery.cleanQuery,
        filteredFiles,
        limit,
        params
      );
      const contentTime = performance.now() - contentStart;

      // 4. Consolidate results
      const consolidateStart = performance.now();
      const consolidateResult = await this.resultConsolidator.consolidateResultsByFile(
        contentResult.results || []
      );
      const consolidateTime = performance.now() - consolidateStart;

      if (!consolidateResult.success) {
        throw new Error(consolidateResult.error);
      }

      const totalTime = performance.now() - startTime;

      return consolidateResult.results || [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Execute universal search (returns formatted universal search result)
   */
  async executeUniversalSearch(params: UniversalSearchParams): Promise<UniversalSearchResult> {
    try {
      const startTime = performance.now();
      const { query, limit = 10 } = params;

      // 1. Parse query
      const parseResult = this.queryParser.parseSearchQuery(query);
      if (!parseResult.success) {
        return this.resultFormatter.createErrorResult(query, parseResult.error!);
      }

      const parsedQuery = parseResult.parsed!;

      // 2. Filter files by metadata and paths
      let filteredFiles: TFile[] | undefined;

      // Apply path filtering if paths are provided
      if (params.paths && params.paths.length > 0) {
        const allFiles = this.plugin.app.vault.getMarkdownFiles();
        filteredFiles = this.filterFilesByPaths(allFiles, params.paths);
      }

      if (parsedQuery.tags.length > 0 || parsedQuery.properties.length > 0) {
        const criteria: MetadataSearchCriteria = {
          tags: parsedQuery.tags,
          properties: parsedQuery.properties,
          matchAll: true
        };
        
        if (this.metadataSearchService) {
          const metadataFiles = await this.metadataSearchService.getFilesMatchingMetadata(criteria);
          
          if (filteredFiles) {
            // Intersect with existing filtered files
            const metadataPathSet = new Set(metadataFiles.map((f: TFile) => f.path));
            filteredFiles = filteredFiles.filter(f => metadataPathSet.has(f.path));
          } else {
            filteredFiles = metadataFiles;
          }
        }
      }

      // 3. Execute parallel searches
      const [contentResult, fileResult, tagResult, propertyResult] = await Promise.all([
        this.contentSearchStrategy.searchContent(parsedQuery.cleanQuery, filteredFiles, limit, params),
        this.fileSearchStrategy.searchFiles(query, limit, filteredFiles),
        this.metadataSearchStrategy.searchTags(query, limit),
        this.metadataSearchStrategy.searchProperties(query, limit)
      ]);

      // 4. Extract results
      const contentResults = contentResult.results || [];
      const fileResults = fileResult.results || [];
      const tagResults = tagResult.results || [];
      const propertyResults = propertyResult.results || [];

      // 5. Format results
      const executionTime = performance.now() - startTime;
      const semanticAvailable = this.serviceInitializer.isSemanticSearchAvailable();

      const formatResult = this.resultFormatter.formatUniversalSearchResult(
        query,
        contentResults,
        fileResults,
        tagResults,
        propertyResults,
        executionTime,
        limit,
        semanticAvailable,
        {}
      );

      if (!formatResult.success) {
        return this.resultFormatter.createErrorResult(query, formatResult.error!);
      }

      return formatResult.result!;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.resultFormatter.createErrorResult(params.query, errorMessage);
    }
  }

  /**
   * Get service diagnostics
   */
  async getServiceDiagnostics(): Promise<any> {
    try {
      return await this.serviceInitializer.getServiceDiagnostics();
    } catch (error) {
      return {
        services: {
          metadataSearch: false,
          hybridSearch: false,
          memory: false,
          workspace: false
        },
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Check if semantic search is available
   */
  isSemanticSearchAvailable(): boolean {
    return this.serviceInitializer.isSemanticSearchAvailable();
  }

  /**
   * Check if hybrid search is available
   */
  isHybridSearchAvailable(): boolean {
    return this.serviceInitializer.isHybridSearchAvailable();
  }

  /**
   * Get search capabilities
   */
  getSearchCapabilities(): {
    content: boolean;
    files: boolean;
    tags: boolean;
    properties: boolean;
    semantic: boolean;
    hybrid: boolean;
  } {
    return {
      content: true,
      files: true,
      tags: true,
      properties: true,
      semantic: this.isSemanticSearchAvailable(),
      hybrid: this.isHybridSearchAvailable()
    };
  }

  /**
   * Update services (for hot-reloading)
   */
  updateServices(services: {
    memoryService?: MemoryService;
    workspaceService?: WorkspaceService;
  }): void {
    // Update service references

    if (services.memoryService) {
      this.memoryService = services.memoryService;
      this.serviceInitializer.updateService('memoryService', services.memoryService);
    }

    if (services.workspaceService) {
      this.workspaceService = services.workspaceService;
      this.serviceInitializer.updateService('workspaceService', services.workspaceService);
    }

    // Update search strategies (no services needed for keyword-only search)
    this.contentSearchStrategy.updateServices();
  }
}