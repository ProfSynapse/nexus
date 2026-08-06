import { Plugin, TFile, prepareFuzzySearch } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { getErrorMessage } from '../../../utils/errorUtils';
import { BRAND_NAME } from '../../../constants/branding';
import { isGlobPattern, globToRegex, normalizePath } from '../../../utils/pathUtils';
import { EmbeddingService } from '../../../services/embeddings/EmbeddingService';
import { EmbeddingManager } from '../../../services/embeddings/EmbeddingManager';
import { CommonParameters } from '../../../types';
import type { ToolStatusTense } from '../../interfaces/ITool';
import { labelQuery, verbs } from '../../utils/toolStatusLabels';

type SearchContentSchema = ReturnType<BaseTool<ContentSearchParams, ContentSearchResult>['getMergedSchema']>;

/**
 * Extended plugin interface that includes optional embedding manager
 */
interface PluginWithEmbeddings extends Plugin {
  embeddingManager?: EmbeddingManager;
}

/**
 * How a result was matched.
 *
 * - `content` — the query was found in the file body.
 * - `path`    — only the filename matched; the body does not contain the query.
 * - `semantic` — surfaced by vector similarity, not by literal matching.
 *
 * Callers previously had no way to tell these apart: a filename-only hit was
 * detectable only by its `content` field falling back to `"File: <path>"`,
 * which was a side effect of the snippet extractor rather than a contract.
 */
export type SearchMatchType = 'content' | 'path' | 'semantic';

/**
 * Internal search result with scoring
 * Used internally for ranking before returning clean results to caller
 */
interface ScoredSearchResult {
  filePath: string;
  frontmatter?: Record<string, unknown>;
  content?: string;
  matchType: SearchMatchType;
  _score: number; // Internal property for sorting
}

export interface ContentSearchParams extends CommonParameters {
  query: string;
  semantic?: boolean;  // Default: false (keyword search). Set true for vector/embedding search
  limit?: number;
  includeContent?: boolean;
  snippetLength?: number;
  paths?: string[];
}

export interface ContentSearchResult {
  success: boolean;
  results: Array<{
    filePath: string;
    frontmatter?: Record<string, unknown>;
    content?: string;  // Keyword search only
    matchType: SearchMatchType;
  }>;
  error?: string;
}

/** Score for a verbatim occurrence of the whole query. */
const EXACT_PHRASE_SCORE = 0.9;
/** Ceiling for "every query word is present, but not as a phrase". */
const ALL_WORDS_SCORE = 0.8;
/** Floor for "at least one query word is present". */
const PARTIAL_MATCH_FLOOR = 0.3;
/**
 * Ceiling for a fuzzy-only filename hit — a scattered subsequence match on a
 * name that contains none of the query terms.
 *
 * Deliberately below PARTIAL_MATCH_FLOOR. Obsidian's `prepareFuzzySearch`
 * returns small negative scores even for weak scattered matches, so the old
 * `1 + score/100` normalization put nearly every filename hit around 0.95 —
 * above the 0.9 an exact phrase in the body could ever reach. Files containing
 * none of the query terms therefore outranked files containing it verbatim.
 *
 * Fuzzy is kept, because it is the only signal that tolerates typos and
 * abbreviations, but it now ranks below every deliberate match rather than
 * above them.
 */
const FUZZY_ONLY_CEILING = 0.25;

/**
 * Score how well `text` matches the query, using one tier ladder.
 *
 * Filenames and file bodies are both scored through this function so their
 * scores are commensurable by construction. Previously the filename was scored
 * on the fuzzy scale and the body on this tier ladder, and the two were
 * compared directly despite never having been calibrated against each other.
 *
 * Returns `matchIndex`/`matchLength` so callers can extract a snippet without
 * re-running the search.
 */
function scoreTextMatch(
  normalizedQuery: string,
  normalizedText: string
): { found: boolean; exact: boolean; score: number; matchIndex: number; matchLength: number } {
  const exactIndex = normalizedText.indexOf(normalizedQuery);
  if (exactIndex !== -1) {
    return {
      found: true,
      exact: true,
      score: EXACT_PHRASE_SCORE,
      matchIndex: exactIndex,
      matchLength: normalizedQuery.length
    };
  }

  const queryWords = normalizedQuery.split(/\s+/).filter(word => word.length > 2);
  const wordMatches = queryWords.filter(word => normalizedText.includes(word));

  if (wordMatches.length === 0) {
    return { found: false, exact: false, score: 0, matchIndex: -1, matchLength: 0 };
  }

  const matchRatio = wordMatches.length / queryWords.length;
  const score = Math.max(PARTIAL_MATCH_FLOOR, matchRatio * ALL_WORDS_SCORE);
  const firstMatch = wordMatches[0];

  return {
    found: true,
    exact: false,
    score,
    matchIndex: normalizedText.indexOf(firstMatch),
    matchLength: firstMatch.length
  };
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
      'content',
      'Content Search',
      'Search vault files. Set semantic=true for AI-powered conceptual search using local embeddings (best for concepts/related ideas), or semantic=false for keyword/fuzzy search (best for exact matches). Semantic search is desktop-only and becomes available once the embedding system initializes in the background (first run may take longer while the model downloads).',
      '2.0.0'
    );
    this.plugin = plugin;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelQuery(verbs('Searching notes', 'Searched notes', 'Failed to search notes'), params, tense);
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
      void error;
    }

    return null;
  }

  async execute(params: ContentSearchParams): Promise<ContentSearchResult> {
    const startTime = performance.now();

    try {
      if (!params.query || params.query.trim().length === 0) {
        return this.prepareResult(false, undefined, 'Query parameter is required and cannot be empty');
      }

      const searchParams = {
        query: params.query.trim(),
        semantic: params.semantic ?? false, // Default to keyword search (always available)
        limit: params.limit || 10,
        includeContent: params.includeContent !== false,
        snippetLength: params.snippetLength || 200,
        paths: params.paths || []
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
      const results: ContentSearchResult['results'] = [];
      for (const result of filteredResults.slice(0, searchParams.limit)) {
        const file = this.plugin.app.vault.getAbstractFileByPath(result.notePath);
        if (file instanceof TFile) {
          // Get frontmatter only
          let frontmatter: Record<string, unknown> | undefined;
          const fileCache = this.plugin.app.metadataCache.getFileCache(file);
          if (fileCache?.frontmatter) {
            frontmatter = { ...fileCache.frontmatter };
            delete frontmatter.position;
          }

          const entry: ContentSearchResult['results'][number] = {
            filePath: result.notePath,
            // Vector similarity, not a literal hit — the query may appear
            // nowhere in the file at all, by design.
            matchType: 'semantic'
          };
          if (frontmatter && Object.keys(frontmatter).length > 0) {
            entry.frontmatter = frontmatter;
          }
          results.push(entry);
        }
      }

      void startTime;

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

    void startTime;

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
      const { _score: score, ...rest } = r;
      void score;
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

    // 1. Filename match, scored on the SAME tier ladder as the body so the two
    //    are comparable. A fuzzy hit is a weak fallback for typos and
    //    abbreviations and is capped below every literal match.
    const filename = file.basename;
    const filenameMatch = scoreTextMatch(normalizedQuery, filename.toLowerCase());
    let pathScore = filenameMatch.score;

    if (!filenameMatch.found) {
      const fuzzyResult = fuzzySearch(filename);
      if (fuzzyResult) {
        // Normalize fuzzy score (fuzzy scores are negative, closer to 0 is better)
        const normalized = Math.max(0, Math.min(1, 1 + (fuzzyResult.score / 100)));
        pathScore = normalized * FUZZY_ONLY_CEILING;
      }
    }

    maxScore = Math.max(maxScore, pathScore);

    // 2. Keyword search in file content and extract frontmatter
    let keywordScore = 0;
    let frontmatter: Record<string, unknown> | undefined = undefined;

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
        void error;
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
        void error;
      }
    }

    // 3. Combined scoring for files that match both on name and in the body.
    if (pathScore > 0 && keywordScore > 0) {
      // Weighted combination: 60% keyword + 40% path.
      //
      // Guarded by Math.max because the blend alone can DEMOTE: an exact phrase
      // in the body (0.9) paired with a weak name hit (0.1) blended to 0.58,
      // ranking that file below an identical file whose name did not match at
      // all. Matching a second way must never cost a result its position.
      maxScore = Math.max(maxScore, (keywordScore * 0.6) + (pathScore * 0.4));
    }

    // Only include files with matches
    if (maxScore > 0) {
      // `content` is the honest signal here: it is only non-empty when the body
      // actually matched. `matchType` states it outright rather than leaving
      // callers to infer it from the snippet fallback below.
      const matchType: SearchMatchType = keywordScore > 0 ? 'content' : 'path';

      // If no content snippet from keyword search, use file path
      if (!contentSnippet && includeContent) {
        contentSnippet = `File: ${file.path}`;
      }

      const entry: ScoredSearchResult = {
        filePath: file.path,
        content: contentSnippet,
        matchType,
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

    // Same tier ladder the filename is scored on — see scoreTextMatch.
    const match = scoreTextMatch(normalizedQuery, normalizedContent);

    if (!match.found) {
      return { found: false, score: 0, snippet: '' };
    }

    // An exact phrase hit spans the original query; a word hit spans that word.
    const matchLength = match.exact ? originalQuery.length : match.matchLength;

    return {
      found: true,
      score: match.score,
      snippet: this.extractSnippet(content, match.matchIndex, matchLength, snippetLength)
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
  getParameterSchema(): SearchContentSchema {
    const toolSchema = {
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
          description: 'true = AI-powered conceptual search (desktop only, best for concepts/related ideas). false = keyword/fuzzy search (default, best for exact matches).',
          default: false
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
      required: ['query'],
      additionalProperties: false
    };

    return this.getMergedSchema(toolSchema);
  }

  /**
   * Get result schema for MCP tool definition
   */
  getResultSchema(): SearchContentSchema {
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
              },
              matchType: {
                type: 'string',
                enum: ['content', 'path', 'semantic'],
                description: 'How this file matched. "content" = the query was found in the file body (see the content snippet). "path" = only the filename matched; the body does NOT contain the query, so read the file before relying on it. "semantic" = surfaced by vector similarity, so the query may not appear literally at all.'
              }
            },
            required: ['filePath', 'matchType']
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
