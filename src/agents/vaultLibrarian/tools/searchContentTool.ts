import { Plugin, TFile, prepareFuzzySearch } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { getErrorMessage } from '../../../utils/errorUtils';
import { BRAND_NAME } from '../../../constants/branding';
import { isGlobPattern, globToRegex, normalizePath } from '../../../utils/pathUtils';
import { EmbeddingService } from '../../../services/embeddings/EmbeddingService';
import { EmbeddingManager } from '../../../services/embeddings/EmbeddingManager';

/**
 * Extended plugin interface that includes optional embedding manager
 */
interface PluginWithEmbeddings extends Plugin {
  embeddingManager?: EmbeddingManager;
}

/**
 * Internal search result with scoring
 * Used internally for ranking before returning clean results to caller
 */
interface ScoredSearchResult {
  filePath: string;
  frontmatter?: Record<string, any>;
  content?: string;
  _score: number; // Internal property for sorting
}

export interface ContentSearchParams {
  query: string;
  semantic: boolean;  // REQUIRED: true for vector/embedding search, false for keyword/fuzzy
  limit?: number;
  includeContent?: boolean;
  snippetLength?: number;
  paths?: string[];
  context: {
    sessionId: string;
    workspaceId?: string;
    sessionDescription: string;
    sessionMemory: string;
    toolContext: string;
    primaryGoal: string;
    subgoal: string;
  };
  sessionId?: string;
}

export interface ContentSearchResult {
  success: boolean;
  results: Array<{
    filePath: string;
    frontmatter?: Record<string, any>;
    content?: string;  // Keyword search only
  }>;
  error?: string;
}

/**
 * Content search tool with both semantic (vector) and keyword search capabilities
 *
 * - semantic: true → Uses embedding-based vector similarity search (best for conceptual queries)
 * - semantic: false → Uses Obsidian's fuzzy + keyword search (best for exact matches)
 */
export class SearchContentTool extends BaseTool<ContentSearchParams, ContentSearchResult> {
  private plugin: Plugin;
  private embeddingService: EmbeddingService | null = null;

  constructor(plugin: Plugin) {
    super(
      'searchContent',
      'Content Search',
      'Search vault files. Set semantic=true for AI-powered conceptual search using local embeddings (best for concepts/related ideas), or semantic=false for keyword/fuzzy search (best for exact matches). Semantic search is desktop-only and becomes available once the embedding system initializes in the background (first run may take longer while the model downloads).',
      '2.0.0'
    );
    this.plugin = plugin;
  }

  /**
   * Set the embedding service for semantic search
   */
  setEmbeddingService(service: EmbeddingService): void {
    this.embeddingService = service;
  }

  /**
   * Lazily get the embedding service from the plugin
   * This handles the timing issue where EmbeddingManager initializes after VaultLibrarian
   */
  private getEmbeddingService(): EmbeddingService | null {
    // Return cached service if available
    if (this.embeddingService) {
      return this.embeddingService;
    }

    // Try to get from plugin's embeddingManager
    try {
      const pluginWithEmbeddings = this.plugin as PluginWithEmbeddings;
      if (pluginWithEmbeddings.embeddingManager) {
        const service = pluginWithEmbeddings.embeddingManager.getService();
        if (service) {
          this.embeddingService = service; // Cache for future use
          return service;
        }
      }
    } catch (error) {
    }

    return null;
  }

  async execute(params: ContentSearchParams): Promise<ContentSearchResult> {
    const startTime = performance.now();

    try {
      if (!params.query || params.query.trim().length === 0) {
        return this.prepareResult(false, undefined, 'Query parameter is required and cannot be empty');
      }

      if (params.semantic === undefined) {
        return this.prepareResult(false, undefined, 'semantic parameter is required. Set to true for AI-powered conceptual search, or false for keyword/fuzzy search.');
      }

      const searchParams = {
        query: params.query.trim(),
        semantic: params.semantic,
        limit: params.limit || 10,
        includeContent: params.includeContent !== false,
        snippetLength: params.snippetLength || 200,
        paths: params.paths || [],
        context: params.context
      };

      // Use semantic search if requested
      if (searchParams.semantic) {
        return await this.performSemanticSearch(searchParams, startTime);
      }

      // Otherwise use keyword/fuzzy search
      return await this.performKeywordFuzzySearch(searchParams, startTime);

    } catch (error) {
      console.error(`[${BRAND_NAME}] Content search failed:`, error);
      return this.prepareResult(false, undefined, `Search failed: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Perform semantic (vector) search using embeddings
   */
  private async performSemanticSearch(
    searchParams: { query: string; limit: number; paths: string[]; includeContent: boolean; snippetLength: number },
    startTime: number
  ): Promise<ContentSearchResult> {
    // Lazily get the embedding service (handles timing issues)
    const embeddingService = this.getEmbeddingService();

    if (!embeddingService) {
      return this.prepareResult(false, undefined, 'Semantic search is not available yet. The embedding system may still be initializing (and may need to download the embedding model on first run). Try again in a moment, or use semantic=false for keyword search.');
    }

    if (!embeddingService.isServiceEnabled()) {
      return this.prepareResult(false, undefined, 'Embedding service is disabled (mobile platform or initialization failed). Use semantic=false for keyword search.');
    }

    // Check if we have any embeddings
    const stats = await embeddingService.getStats();
    if (stats.noteCount === 0) {
      return this.prepareResult(false, undefined, 'No embeddings found. The vault is likely still being indexed. Please wait for indexing to complete, or use semantic=false for keyword search.');
    }

    try {
      // Use EmbeddingService.semanticSearch()
      const semanticResults = await embeddingService.semanticSearch(searchParams.query, searchParams.limit * 2); // Get extra for path filtering

      if (semanticResults.length === 0) {
        return this.prepareResult(false, undefined, 'Semantic search returned no results. This may indicate an issue with the vector database. Please check the console for errors.');
      }

      // Filter by paths if specified
      let filteredResults = semanticResults;
      if (searchParams.paths.length > 0) {
        const globPatterns = searchParams.paths
          .filter(p => isGlobPattern(p))
          .map(p => globToRegex(p));

        const literalPaths = searchParams.paths
          .filter(p => !isGlobPattern(p))
          .map(p => normalizePath(p));

        filteredResults = semanticResults.filter(result => {
          const matchesLiteral = literalPaths.some(path => {
            // Empty path (from "/") matches everything
            if (path === '') return true;
            return result.notePath.startsWith(path);
          });
          const matchesGlob = globPatterns.some(regex => regex.test(result.notePath));
          return matchesLiteral || matchesGlob;
        });
      }

      // Convert to lean result format (just filePath + frontmatter)
      const results: Array<{ filePath: string; frontmatter?: Record<string, any> }> = [];
      for (const result of filteredResults.slice(0, searchParams.limit)) {
        const file = this.plugin.app.vault.getAbstractFileByPath(result.notePath);
        if (file instanceof TFile) {
          // Get frontmatter only
          let frontmatter: Record<string, any> | undefined;
          const fileCache = this.plugin.app.metadataCache.getFileCache(file);
          if (fileCache?.frontmatter) {
            frontmatter = { ...fileCache.frontmatter };
            delete frontmatter.position;
          }

          const entry: { filePath: string; frontmatter?: Record<string, any> } = {
            filePath: result.notePath
          };
          if (frontmatter && Object.keys(frontmatter).length > 0) {
            entry.frontmatter = frontmatter;
          }
          results.push(entry);
        }
      }

      const executionTime = performance.now() - startTime;

      return this.prepareResult(true, {
        results
      });

    } catch (error) {
      console.error(`[${BRAND_NAME}] Semantic search failed:`, error);
      return this.prepareResult(false, undefined, `Semantic search failed: ${getErrorMessage(error)}. Try semantic=false for keyword search.`);
    }
  }

  /**
   * Perform keyword/fuzzy search (original behavior)
   */
  private async performKeywordFuzzySearch(
    searchParams: { query: string; limit: number; paths: string[]; includeContent: boolean; snippetLength: number },
    startTime: number
  ): Promise<ContentSearchResult> {
    // Get all markdown files
    let allFiles = this.plugin.app.vault.getMarkdownFiles();

    // Filter by paths if specified
    if (searchParams.paths.length > 0) {
      const globPatterns = searchParams.paths
        .filter(p => isGlobPattern(p))
        .map(p => globToRegex(p));

      const literalPaths = searchParams.paths
        .filter(p => !isGlobPattern(p))
        .map(p => normalizePath(p));

      allFiles = allFiles.filter(file => {
        const matchesLiteral = literalPaths.some(path => {
          // Empty path (from "/") matches everything
          if (path === '') return true;
          return file.path.startsWith(path);
        });
        const matchesGlob = globPatterns.some(regex => regex.test(file.path));
        return matchesLiteral || matchesGlob;
      });
    }

    // Perform combined fuzzy + keyword search
    const searchResults = await this.performCombinedSearch(
      searchParams.query,
      allFiles,
      searchParams.limit,
      searchParams.includeContent,
      searchParams.snippetLength
    );

    const executionTime = performance.now() - startTime;

    return this.prepareResult(true, {
      results: searchResults
    });
  }

  /**
   * Perform combined fuzzy and keyword search with result ranking
   */
  private async performCombinedSearch(
    query: string,
    files: TFile[],
    limit: number,
    includeContent: boolean,
    snippetLength: number
  ): Promise<ContentSearchResult['results']> {
    const normalizedQuery = query.toLowerCase();
    const fuzzySearch = prepareFuzzySearch(normalizedQuery);
    const allResults: ScoredSearchResult[] = [];

    for (const file of files) {
      const results = await this.searchInFile(
        file,
        query,
        normalizedQuery,
        fuzzySearch,
        includeContent,
        snippetLength
      );
      allResults.push(...results);
    }

    // Sort by internal score (higher is better) and take top results
    allResults.sort((a, b) => (b._score || 0) - (a._score || 0));
    // Strip internal score before returning
    const finalResults = allResults.slice(0, limit).map(r => {
      const { _score, ...rest } = r;
      return rest;
    });
    return finalResults;
  }

  /**
   * Search within a single file using multiple methods
   */
  private async searchInFile(
    file: TFile,
    originalQuery: string,
    normalizedQuery: string,
    fuzzySearch: (text: string) => { score: number } | null,
    includeContent: boolean,
    snippetLength: number
  ): Promise<ScoredSearchResult[]> {
    const results: ScoredSearchResult[] = [];
    let maxScore = 0;
    let contentSnippet = '';

    // 1. Fuzzy search on filename
    const filename = file.basename;
    const fuzzyResult = fuzzySearch(filename);
    let fuzzyScore = 0;

    if (fuzzyResult) {
      // Normalize fuzzy score (fuzzy scores are negative, closer to 0 is better)
      fuzzyScore = Math.max(0, Math.min(1, 1 + (fuzzyResult.score / 100)));
      maxScore = Math.max(maxScore, fuzzyScore);
    }

    // 2. Keyword search in file content and extract frontmatter
    let keywordScore = 0;
    let frontmatter: Record<string, any> | undefined = undefined;

    if (includeContent) {
      try {
        const fileContent = await this.plugin.app.vault.read(file);

        // Extract frontmatter using Obsidian's metadata cache
        const fileCache = this.plugin.app.metadataCache.getFileCache(file);
        if (fileCache?.frontmatter) {
          frontmatter = { ...fileCache.frontmatter };
          // Remove the position property as it's internal metadata
          delete frontmatter.position;
        }

        const keywordResult = this.performKeywordSearch(originalQuery, normalizedQuery, fileContent, snippetLength);

        if (keywordResult.found) {
          keywordScore = keywordResult.score;
          contentSnippet = keywordResult.snippet;

          if (keywordScore > maxScore) {
            maxScore = keywordScore;
          }
        }
      } catch (error) {
      }
    } else {
      // Even if not including content, still extract frontmatter
      try {
        const fileCache = this.plugin.app.metadataCache.getFileCache(file);
        if (fileCache?.frontmatter) {
          frontmatter = { ...fileCache.frontmatter };
          delete frontmatter.position;
        }
      } catch (error) {
      }
    }

    // 3. Combined scoring for files that match both fuzzy and keyword
    if (fuzzyScore > 0 && keywordScore > 0) {
      // Weighted combination: 60% keyword + 40% fuzzy
      maxScore = (keywordScore * 0.6) + (fuzzyScore * 0.4);
    }

    // Only include files with matches
    if (maxScore > 0) {
      // If no content snippet from keyword search, use file path
      if (!contentSnippet && includeContent) {
        contentSnippet = `File: ${file.path}`;
      }

      const entry: ScoredSearchResult = {
        filePath: file.path,
        content: contentSnippet,
        _score: maxScore
      };
      if (frontmatter && Object.keys(frontmatter).length > 0) {
        entry.frontmatter = frontmatter;
      }
      results.push(entry);
    }

    return results;
  }

  /**
   * Perform keyword search in file content
   */
  private performKeywordSearch(
    originalQuery: string,
    normalizedQuery: string,
    content: string,
    snippetLength: number
  ): { found: boolean; score: number; snippet: string } {
    const normalizedContent = content.toLowerCase();

    // Look for exact phrase match first (highest score)
    const exactIndex = normalizedContent.indexOf(normalizedQuery);
    if (exactIndex !== -1) {
      return {
        found: true,
        score: 0.9,
        snippet: this.extractSnippet(content, exactIndex, originalQuery.length, snippetLength)
      };
    }

    // Look for individual word matches
    const queryWords = normalizedQuery.split(/\s+/).filter(word => word.length > 2);
    const wordMatches = queryWords.filter(word => normalizedContent.includes(word));

    if (wordMatches.length === 0) {
      return { found: false, score: 0, snippet: '' };
    }

    // Score based on word match ratio
    const matchRatio = wordMatches.length / queryWords.length;
    const score = Math.max(0.3, matchRatio * 0.8);

    // Find snippet around first word match
    const firstMatch = wordMatches[0];
    const firstMatchIndex = normalizedContent.indexOf(firstMatch);

    return {
      found: true,
      score,
      snippet: this.extractSnippet(content, firstMatchIndex, firstMatch.length, snippetLength)
    };
  }

  /**
   * Extract content snippet around a match
   */
  private extractSnippet(content: string, matchIndex: number, matchLength: number, snippetLength: number): string {
    const halfSnippet = Math.floor(snippetLength / 2);
    const start = Math.max(0, matchIndex - halfSnippet);
    const end = Math.min(content.length, matchIndex + matchLength + halfSnippet);

    let snippet = content.substring(start, end);

    // Add ellipsis if truncated
    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet = snippet + '...';

    return snippet.trim();
  }

  /**
   * Get parameter schema for MCP tool definition
   */
  getParameterSchema() {
    const schema = {
      type: 'object',
      title: 'Content Search Params',
      description: 'Search vault files. REQUIRED: Set "semantic" parameter to choose search mode.',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find files and content.'
        },
        semantic: {
          type: 'boolean',
          description: 'REQUIRED. true = AI-powered conceptual search using embeddings (best for finding related content, concepts, similar ideas). false = keyword/fuzzy search (best for exact text matches, file names).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
          minimum: 1,
          maximum: 50,
          default: 10
        },
        includeContent: {
          type: 'boolean',
          description: 'For keyword search only: include content snippets (default: true). Ignored for semantic search.',
          default: true
        },
        snippetLength: {
          type: 'number',
          description: 'For keyword search only: length of content snippets (default: 200). Ignored for semantic search.',
          minimum: 50,
          maximum: 1000,
          default: 200
        },
        paths: {
          type: 'array',
          description: 'Restrict search to specific folder paths. Supports glob patterns.',
          items: { type: 'string' }
        }
      },
      required: ['query', 'semantic'],
      additionalProperties: false
    };

    return this.getMergedSchema(schema);
  }

  /**
   * Get result schema for MCP tool definition
   */
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
              filePath: {
                type: 'string',
                description: 'Path to the file'
              },
              frontmatter: {
                type: 'object',
                description: 'File frontmatter if present',
                additionalProperties: true
              },
              content: {
                type: 'string',
                description: 'Content snippet (keyword search only)'
              }
            },
            required: ['filePath']
          }
        },
        error: {
          type: 'string',
          description: 'Error message if failed'
        }
      },
      required: ['success', 'results'],
      additionalProperties: false
    };
  }
}
