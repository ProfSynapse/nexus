import { 
  PromptExecutionResult, 
  BatchExecutePromptResult, 
  ExecutionStats, 
  MergedResponse 
} from '../types';

/**
 * Service responsible for processing and formatting execution results
 * Follows SRP by focusing only on result processing logic
 */
export class ResultProcessor {

  /**
   * Process results into final batch execution result
   */
  processResults(
    results: PromptExecutionResult[],
    mergeResponses: boolean,
    totalExecutionTime: number,
    totalPrompts: number
  ): BatchExecutePromptResult {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    const stats: ExecutionStats = {
      totalExecutionTimeMS: totalExecutionTime,
      promptsExecuted: totalPrompts,
      promptsFailed: failed.length,
      avgExecutionTimeMS: totalPrompts > 0 ? totalExecutionTime / totalPrompts : 0,
      tokensUsed: this.calculateTotalTokens(results)
    };

    if (mergeResponses) {
      const merged = this.mergePromptResults(successful);
      
      return {
        success: true,
        merged: {
          totalPrompts,
          successfulPrompts: successful.length,
          combinedResponse: merged.combinedResponse,
          providersUsed: merged.providersUsed
        },
        stats
      };
    } else {
      return {
        success: true,
        results: results,
        stats
      };
    }
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
  private mergePromptResults(results: PromptExecutionResult[]): MergedResponse {
    const responses: string[] = [];
    const providersUsed = new Set<string>();
    
    results.forEach((result, index) => {
      if (result.success) {
        let responseContent = '';
        
        if (result.type === 'text' && result.response) {
          responseContent = result.response;
        } else if (result.type === 'image' && result.imagePath) {
          responseContent = `[Image generated: ${result.imagePath}]`;
        }
        
        if (responseContent) {
          responses.push(
            `## Response ${index + 1}${result.id ? ` (${result.id})` : ''}${result.provider ? ` - ${result.provider}` : ''}\n\n${responseContent}`
          );
          
          if (result.provider) {
            providersUsed.add(result.provider);
          }
        }
      }
    });
    
    const combinedResponse = responses.join('\n\n---\n\n');
    
    return {
      totalPrompts: results.length,
      successfulPrompts: results.filter(r => r.success).length,
      combinedResponse,
      providersUsed: Array.from(providersUsed)
    };
  }

  /**
   * Calculate total tokens used across all results
   */
  private calculateTotalTokens(results: PromptExecutionResult[]): number | undefined {
    let totalTokens = 0;
    let hasTokenData = false;

    for (const result of results) {
      if (result.usage) {
        if (result.type === 'text' && 'totalTokens' in result.usage && result.usage.totalTokens) {
          totalTokens += result.usage.totalTokens;
          hasTokenData = true;
        }
        // Note: Image usage has different metrics (imagesGenerated, resolution, etc.)
        // and doesn't have totalTokens, so we skip those for token calculation
      }
    }

    return hasTokenData ? totalTokens : undefined;
  }

  /**
   * Calculate total cost across all results
   */
  calculateTotalCost(results: PromptExecutionResult[]): { totalCost: number; currency: string } | undefined {
    let totalCost = 0;
    let currency = 'USD';
    let hasCostData = false;

    for (const result of results) {
      if (result.cost?.totalCost) {
        totalCost += result.cost.totalCost;
        currency = result.cost.currency || 'USD';
        hasCostData = true;
      }
    }

    return hasCostData ? { totalCost, currency } : undefined;
  }

  /**
   * Get summary statistics for reporting
   */
  getResultsSummary(results: PromptExecutionResult[]) {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    const providersUsed = new Set(results.map(r => r.provider).filter(Boolean));
    const modelsUsed = new Set(results.map(r => r.model).filter(Boolean));

    return {
      total: results.length,
      successful: successful.length,
      failed: failed.length,
      successRate: results.length > 0 ? (successful.length / results.length) * 100 : 0,
      providersUsed: Array.from(providersUsed),
      modelsUsed: Array.from(modelsUsed),
      totalCost: this.calculateTotalCost(results),
      totalTokens: this.calculateTotalTokens(results)
    };
  }

  /**
   * Filter results by criteria
   */
  filterResults(
    results: PromptExecutionResult[],
    criteria: {
      onlySuccessful?: boolean;
      onlyFailed?: boolean;
      provider?: string;
      sequence?: number;
      parallelGroup?: string;
    }
  ): PromptExecutionResult[] {
    return results.filter(result => {
      if (criteria.onlySuccessful && !result.success) return false;
      if (criteria.onlyFailed && result.success) return false;
      if (criteria.provider && result.provider !== criteria.provider) return false;
      if (criteria.sequence !== undefined && result.sequence !== criteria.sequence) return false;
      if (criteria.parallelGroup && result.parallelGroup !== criteria.parallelGroup) return false;
      return true;
    });
  }
}