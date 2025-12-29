/**
 * FuzzySearchTypes - Type definitions for fuzzy search functionality with typo tolerance and similarity matching
 * Location: src/types/search/FuzzySearchTypes.ts
 * Usage: Provides type safety for fuzzy search operations across the application
 */

export interface FuzzySearchResult {
  id: string;
  title: string;
  snippet: string;
  score: number;
  searchMethod: 'fuzzy';
  metadata: FuzzySearchMetadata;
  content?: string;
}

export interface FuzzySearchMetadata {
  filePath: string;
  fileId: string;
  timestamp: number;
  fuzzyMatches: FuzzyMatch[];
  editDistance: number;
  similarity: number;
  // Enhanced quality metadata
  qualityTier?: FuzzyQualityTier;
  confidenceLevel?: number;
  matchType?: string;
  qualityDescription?: string;
  matchCount?: number;
  searchTermCount?: number;
  matchRatio?: number;
  averageEditDistance?: number;
  exactMatches?: number;
  typoMatches?: number;
  phoneticMatches?: number;
  scoreMethod?: string;
}

export interface FuzzyMatch {
  original: string;
  matched: string;
  distance: number;
  similarity: number;
  matchType: FuzzyMatchType;
}

export interface FuzzyDocument {
  id: string;
  title: string;
  content: string;
  filePath: string;
  metadata: Record<string, unknown>;
}

export interface FuzzyMatchResult {
  score: number;
  matches: FuzzyMatch[];
  totalDistance: number;
}

export interface FuzzyQualityAssessment {
  tier: FuzzyQualityTier;
  confidence: number;
  matchType: string;
  description: string;
}

export interface FuzzySearchStats {
  totalDocuments: number;
  cachedStems: number;
  synonymMappings: number;
  scoreBasedRanking?: boolean;
}

export interface FuzzySearchOptions {
  limit?: number;
  threshold?: number;
  useScoreBasedRanking?: boolean;
  maxEditDistance?: number;
  minSimilarity?: number;
}

export interface FuzzyQualityDistribution {
  high: number;
  medium: number;
  low: number;
  minimal: number;
}

// Type enums
export type FuzzyMatchType = 'typo' | 'stem' | 'synonym' | 'phonetic';
export type FuzzyQualityTier = 'high' | 'medium' | 'low' | 'minimal';

// Constants for fuzzy search configuration
export const FUZZY_SEARCH_DEFAULTS = {
  LIMIT: 10,
  THRESHOLD: 0.6,
  MIN_WORD_LENGTH: 3,
  MAX_EDIT_DISTANCE_RATIO: 0.3,
  SNIPPET_MAX_LENGTH: 300,
  WINDOW_SIZE: 50,
  TOP_MATCHES_PER_TERM: 3,
  MIN_STEM_LENGTH: 3,
  SOUNDEX_LENGTH: 4,
  SCORE_THRESHOLDS: {
    HIGH_EXACT: 0.95,
    HIGH_TYPO: 0.8,
    MEDIUM: 0.6,
    LOW: 0.4
  },
  SIMILARITY_WEIGHTS: {
    EXACT: 1.0,
    STEM: 0.9,
    SYNONYM: 0.8,
    PHONETIC: 0.7,
    TYPO_MIN: 0.6
  }
} as const;

// Utility type for internal search operations
export interface FuzzySearchContext {
  searchTerms: string[];
  useThresholdFiltering: boolean;
  qualityDistribution?: FuzzyQualityDistribution;
}

// Type for synonym mappings
export type SynonymMappings = Record<string, string[]>;

// Type for stem cache
export type StemCache = Map<string, string>;

// Type for soundex character mappings
export type SoundexMapping = Record<string, string>;

// Type guards
export function isFuzzySearchResult(obj: any): obj is FuzzySearchResult {
  return obj && 
    typeof obj.id === 'string' && 
    typeof obj.title === 'string' && 
    typeof obj.snippet === 'string' && 
    typeof obj.score === 'number' && 
    obj.searchMethod === 'fuzzy' &&
    obj.metadata &&
    Array.isArray(obj.metadata.fuzzyMatches);
}

export function isFuzzyMatch(obj: any): obj is FuzzyMatch {
  return obj &&
    typeof obj.original === 'string' &&
    typeof obj.matched === 'string' &&
    typeof obj.distance === 'number' &&
    typeof obj.similarity === 'number' &&
    ['typo', 'stem', 'synonym', 'phonetic'].includes(obj.matchType);
}

export function isFuzzyDocument(obj: any): obj is FuzzyDocument {
  return obj &&
    typeof obj.id === 'string' &&
    typeof obj.title === 'string' &&
    typeof obj.content === 'string' &&
    typeof obj.filePath === 'string' &&
    obj.metadata &&
    typeof obj.metadata === 'object';
}