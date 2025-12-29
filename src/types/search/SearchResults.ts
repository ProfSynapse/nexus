/**
 * SearchResults.ts - Type definitions for search result interfaces
 * Location: src/types/search/SearchResults.ts
 * Purpose: Provides standardized interfaces for search results across all search services
 * Used by: HybridSearchService, SearchMetrics, ResultFusion, and QueryCoordinator
 */

export interface SearchResult {
  /** Unique result identifier */
  id: string;
  
  /** Result title */
  title: string;
  
  /** Content snippet or excerpt */
  snippet: string;
  
  /** Relevance score (0-1) */
  score: number;
  
  /** Search method that produced this result */
  searchMethod: 'semantic' | 'keyword' | 'fuzzy' | 'hybrid';
  
  /** Result metadata */
  metadata: SearchResultMetadata;
  
  /** Full content (optional) */
  content?: string;
  
  /** File path if applicable */
  filePath?: string;
}

export interface SearchResultMetadata {
  /** File path */
  filePath: string;
  
  /** File identifier */
  fileId: string;
  
  /** Result timestamp */
  timestamp: number;
  
  /** Content type */
  type?: string;
  
  /** Search method */
  searchMethod?: string;
  
  /** Quality tier classification */
  qualityTier?: 'high' | 'medium' | 'low' | 'minimal';
  
  /** Confidence level (0-1) */
  confidenceLevel?: number;
  
  /** Match type description */
  matchType?: string;
  
  /** Quality description */
  qualityDescription?: string;
  
  /** Score calculation method */
  scoreMethod?: string;
  
  /** Additional metadata */
  [key: string]: any;
}

export interface HybridSearchResult extends SearchResult {
  /** Always 'hybrid' for hybrid search results */
  searchMethod: 'hybrid';
  
  /** Original search methods that contributed to this result */
  originalMethods: string[];
  
  /** Enhanced hybrid-specific metadata */
  metadata: HybridSearchResultMetadata;
}

export interface HybridSearchResultMetadata extends SearchResultMetadata {
  /** Hybrid fusion score */
  hybridScore: number;
  
  /** Scores from individual search methods */
  methodScores: MethodScores;
  
  /** Content type boost applied */
  contentTypeBoost: number;
  
  /** Exact match boost applied */
  exactMatchBoost: number;
  
  /** Final ranking position */
  finalRank: number;
}

export interface MethodScores {
  semantic?: number;
  keyword?: number;
  fuzzy?: number;
}

export interface SearchResultSet {
  /** Search results */
  results: SearchResult[];
  
  /** Weight for fusion (0-1) */
  weight: number;
  
  /** Result set type identifier */
  type: string;
  
  /** Execution time in milliseconds */
  executionTime?: number;
  
  /** Search method */
  method: string;
  
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  /** Maximum number of results to return */
  limit?: number;
  
  /** Include full content in results */
  includeContent?: boolean;
  
  /** Force semantic search even if weights suggest otherwise */
  forceSemanticSearch?: boolean;
  
  /** Minimum keyword search threshold */
  keywordThreshold?: number;
  
  /** Minimum fuzzy search threshold */
  fuzzyThreshold?: number;
  
  /** Query type hint */
  queryType?: 'exact' | 'conceptual' | 'exploratory' | 'mixed';
  
  /** Search timeout in milliseconds */
  timeout?: number;
  
  /** Enable result caching */
  enableCaching?: boolean;
  
  /** Minimum score threshold for results */
  scoreThreshold?: number;
}

export interface CachedSearchResult {
  /** Cached search results */
  results: HybridSearchResult[];
  
  /** Cache timestamp */
  timestamp: number;
  
  /** Original query */
  query: string;
  
  /** Cache key */
  key: string;
  
  /** Cache hit count */
  hits?: number;
}

export interface SearchContext {
  /** Search session identifier */
  sessionId?: string;
  
  /** User preferences */
  preferences?: Record<string, unknown>;
  
  /** Search filters */
  filters?: Record<string, unknown>;
  
  /** Additional context data */
  metadata?: Record<string, unknown>;
}

export interface RerankItem {
  /** Item identifier */
  id: string;
  
  /** Item score */
  score: number;
  
  /** Search method */
  method: string;
  
  /** Original ranking position */
  rank?: number;
}

export interface FusionOptions {
  /** Fusion strategy to use */
  strategy?: 'rrf' | 'weighted' | 'simple';
  
  /** RRF k parameter */
  k?: number;
  
  /** Custom weights per result type */
  typeWeights?: Record<string, number>;
  
  /** Maximum results after fusion */
  maxResults?: number;
  
  /** Score threshold after fusion */
  scoreThreshold?: number;
}

export interface RankingStrategy {
  /** Ranking algorithm */
  algorithm: 'rrf' | 'weighted' | 'linear';
  
  /** Algorithm parameters */
  parameters: Record<string, unknown>;
}