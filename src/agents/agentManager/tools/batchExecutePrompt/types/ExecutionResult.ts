import { PromptExecutionResult } from './BatchExecuteTypes';

/**
 * Result from batch LLM prompt execution
 */
export interface BatchExecutePromptResult {
  success: boolean;
  /** Individual prompt results (if mergeResponses is false) */
  results?: PromptExecutionResult[];
  /** Merged response (if mergeResponses is true) */
  merged?: {
    totalPrompts: number;
    successfulPrompts: number;
    combinedResponse: string;
    providersUsed: string[];
  };
  /** Execution statistics */
  stats?: {
    totalExecutionTimeMS: number;
    promptsExecuted: number;
    promptsFailed: number;
    avgExecutionTimeMS: number;
    tokensUsed?: number;
  };
  error?: string;
}

/**
 * Execution statistics for monitoring
 */
export interface ExecutionStats {
  totalExecutionTimeMS: number;
  promptsExecuted: number;
  promptsFailed: number;
  avgExecutionTimeMS: number;
  tokensUsed?: number;
}

/**
 * Merged response data
 */
export interface MergedResponse {
  totalPrompts: number;
  successfulPrompts: number;
  combinedResponse: string;
  providersUsed: string[];
}