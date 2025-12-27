import {
  PromptExecutionResult,
  InternalExecutionResult,
  BatchExecutePromptResult,
  ExecutionStats,
  MergedResponse
} from '../types';

/**
 * Service responsible for processing and formatting execution results
 * Strips internal details to return lean, context-efficient results
 */
export class ResultProcessor {

  /**
   * Process results into final batch execution result (lean format)
   */
  processResults(
    results: InternalExecutionResult[],
    mergeResponses: boolean,
    _totalExecutionTime: number,
    _totalPrompts: number
  ): BatchExecutePromptResult {
    const successful = results.filter(r => r.success);

    if (mergeResponses) {
      const merged = this.mergePromptResults(successful);
      return {
        success: true,
        merged: merged.combinedResponse
      };
    } else {
      // Strip to lean format
      const leanResults = results.map(r => this.toLeanResult(r));
      return {
        success: true,
        results: leanResults
      };
    }
  }

  /**
   * Convert internal result to lean public result
   * Type inferred from fields: response/savedTo = text, imagePath = image
   */
  private toLeanResult(result: InternalExecutionResult): PromptExecutionResult {
    const lean: PromptExecutionResult = { success: result.success };

    if (result.type === 'image') {
      if (result.imagePath) lean.imagePath = result.imagePath;
    } else {
      // Only include response if no action saved it to a file
      if (result.response && !result.actionPerformed?.success) {
        lean.response = result.response;
      }
      // Include savedTo path if action was performed
      if (result.actionPerformed?.success && result.actionPerformed.targetPath) {
        lean.savedTo = result.actionPerformed.targetPath;
      }
    }

    if (!result.success && result.error) lean.error = result.error;
    return lean;
  }

  /**
   * Create error result for batch execution failures
   */
  createErrorResult(error: string): BatchExecutePromptResult {
    return {
      success: false,
      error
    };
  }

  /**
   * Merge multiple prompt results into a single unified response
   */
  private mergePromptResults(results: InternalExecutionResult[]): MergedResponse {
    const responses: string[] = [];
    const providersUsed = new Set<string>();

    results.forEach((result) => {
      if (result.success) {
        let content = '';
        if (result.type === 'text' && result.response) {
          content = result.response;
        } else if (result.type === 'image' && result.imagePath) {
          content = `[Image: ${result.imagePath}]`;
        }
        if (content) {
          responses.push(content);
          if (result.provider) providersUsed.add(result.provider);
        }
      }
    });

    return {
      totalPrompts: results.length,
      successfulPrompts: results.filter(r => r.success).length,
      combinedResponse: responses.join('\n\n'),
      providersUsed: Array.from(providersUsed)
    };
  }
}