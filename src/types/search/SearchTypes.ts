/**
 * Search and Memory Query Types
 * Extracted from types.ts for better organization
 */

/**
 * Memory storage types (JSON-based storage)
 */

export interface MemoryQueryParams {
  query: string;         
  limit?: number;        
  threshold?: number;    
  filters?: {            
    tags?: string[];     
    paths?: string[];    
    properties?: Record<string, unknown>;
    dateRange?: {        
      start?: string;
      end?: string;
    }
  },
  graphOptions?: {
    useGraphBoost: boolean;
    boostFactor: number;
    includeNeighbors: boolean;
    maxDistance: number;
    seedNotes?: string[];
  }
}

export interface MemoryQueryResult {
  matches: Array<{
    content: string;
    filePath: string;
    lineStart: number;
    lineEnd: number;
    metadata: {
      frontmatter: Record<string, unknown>;
      tags: string[];
      links: {
        outgoing: Array<{
          displayText: string;
          targetPath: string;
        }>;
        incoming: Array<{
          sourcePath: string;
          displayText: string;
        }>;
      }
    }
  }>
}

