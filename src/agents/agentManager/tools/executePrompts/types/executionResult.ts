import { PromptExecutionResult } from './executeTypes';

/**
 * Result from batch LLM prompt execution (lean for context efficiency)
 */
export interface BatchExecutePromptResult {
  success: boolean;
  /** Individual prompt results - minimal data */
  results?: PromptExecutionResult[];
  /** Combined response when mergeResponses is true */
  merged?: string;
  /** Only included on failure */
  error?: string;
}

/**
 * Internal execution statistics (not returned to caller)
 */
export interface ExecutionStats {
  totalExecutionTimeMS: number;
  promptsExecuted: number;
  promptsFailed: number;
  avgExecutionTimeMS: number;
  tokensUsed?: number;
}

/**
 * Internal merged response data (not returned to caller)
 */
export interface MergedResponse {
  totalPrompts: number;
  successfulPrompts: number;
  combinedResponse: string;
  providersUsed: string[];
}