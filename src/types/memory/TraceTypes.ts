/**
 * src/types/memory/TraceTypes.ts
 * 
 * Memory trace type definitions extracted from MemoryTraceService.ts
 * Contains interface definitions for memory traces, tool call traces, and search operations.
 * Used by MemoryTraceService, ToolCallTraceProcessor, and TraceSearchService.
 */

import { WorkspaceMemoryTrace, TraceMetadata, LegacyWorkspaceTraceMetadata } from '../../database/workspace-types';
// import type { PendingToolCallCapture } from '../../services/toolcall-capture/ToolCallCaptureService';
type PendingToolCallCapture = any;

/**
 * Search options for memory trace queries
 */
export interface MemoryTraceSearchOptions {
  workspaceId?: string;
  workspacePath?: string[];
  limit?: number;
  sessionId?: string;
}

/**
 * Activity trace data structure for tool interactions and user activities
 */
export interface ActivityTraceData {
  type: string;
  content: string;
  metadata: TraceMetadata | LegacyWorkspaceTraceMetadata;
  sessionId?: string;
}

/**
 * Enhanced memory trace for tool call capture with complete JSON preservation.
 * Extends WorkspaceMemoryTrace with tool call specific fields.
 */
export interface ToolCallMemoryTrace extends WorkspaceMemoryTrace {
  // Tool call identification
  toolCallId: string;
  agent: string;
  mode: string;
  toolName: string;
  
  // Enhanced metadata with complete JSON preservation
  metadata: TraceMetadata & {
    // Tool call request data (complete JSON preservation)
    request?: {
      originalParams: Record<string, unknown>;
      normalizedParams: Record<string, unknown>;
      workspaceContext?: {
        workspaceId: string;
        sessionId?: string;
        workspacePath?: string[];
      };
      source: 'mcp-client' | 'internal' | 'agent-trigger';
    };
    
    // Tool call response data (complete JSON preservation)
    response?: {
      result: Record<string, unknown> | null;
      success: boolean;
      error?: {
        type: string;
        message: string;
        code?: string | number;
        stack?: string;
      };
      resultType?: string;
      resultSummary?: string;
      affectedResources?: string[];
    };
    
    // Execution details specific to tool calls
    execution?: {
      agent: string;
      mode: string;
      executionTime: number;
      timestamp: number;
      toolName: string;
    };
  };
  
  // Execution context
  executionContext: {
    timing: {
      startTimestamp: number;
      endTimestamp: number;
      executionTime: number;
    };
    environment: {
      pluginVersion: string;
      platform: string;
    };
    userContext: {
      sessionStart: number;
      sessionDuration: number;
      previousToolCalls: number;
    };
    performance: {
      importance: number;
      complexity: number;
      userEngagement: number;
    };
  };
  
  // Relationships
  relationships: {
    relatedFiles: string[];
    affectedResources: string[];
    sessionToolCalls: string[];
    workspaceContext: string[];
  };
  
  // Search optimization
  searchOptimization: {
    searchContent: {
      primary: string;
      keywords: string[];
      entities: string[];
    };
    categories: {
      functionalCategory: string;
      domainCategory: string;
      complexityCategory: string;
      impactCategory: string;
    };
    searchTags: string[];
    searchScoring: {
      recencyScore: number;
      frequencyScore: number;
      successScore: number;
      impactScore: number;
      userEngagementScore: number;
    };
    indexingHints: {
      shouldIndex: boolean;
      indexPriority: 'high' | 'medium' | 'low';
      cacheStrategy: 'session' | 'workspace' | 'global';
      searchFrequency: 'frequent' | 'occasional' | 'rare';
    };
  };
}

/**
 * Tool call performance metrics
 */
export interface ToolCallPerformanceMetrics {
  importance: number;
  complexity: number;
  userEngagement: number;
}

/**
 * Tool call relationships structure
 */
export interface ToolCallRelationships {
  relatedFiles: string[];
  affectedResources: string[];
  sessionToolCalls: string[];
  workspaceContext: string[];
}

/**
 * Search optimization data structure
 */
export interface ToolCallSearchOptimization {
  searchContent: {
    primary: string;
    keywords: string[];
    entities: string[];
  };
  categories: {
    functionalCategory: string;
    domainCategory: string;
    complexityCategory: string;
    impactCategory: string;
  };
  searchTags: string[];
  searchScoring: {
    recencyScore: number;
    frequencyScore: number;
    successScore: number;
    impactScore: number;
    userEngagementScore: number;
  };
  indexingHints: {
    shouldIndex: boolean;
    indexPriority: 'high' | 'medium' | 'low';
    cacheStrategy: 'session' | 'workspace' | 'global';
    searchFrequency: 'frequent' | 'occasional' | 'rare';
  };
}

/**
 * Search result with similarity score
 */
export interface MemoryTraceSearchResult {
  trace: WorkspaceMemoryTrace;
  similarity: number;
}

/**
 * Tool call processing context
 */
export interface ToolCallProcessingContext {
  request: any;
  response: any;
  sessionContext: any;
  shouldIndex: boolean;
  searchContent: string;
  relationships: ToolCallRelationships;
  performanceMetrics: ToolCallPerformanceMetrics;
  searchOptimization: ToolCallSearchOptimization;
}
