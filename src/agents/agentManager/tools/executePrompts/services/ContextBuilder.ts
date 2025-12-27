import { ExecutionContext, InternalExecutionResult, PromptConfig } from '../types';

/**
 * Service responsible for building context from previous execution results
 * Follows SRP by focusing only on context building logic
 */
export class ContextBuilder {

  /**
   * Build context string from previous sequence and group results with precise ID-based selection
   */
  buildPreviousResultsContext(
    previousResults: Map<number, InternalExecutionResult[]> | { [sequence: number]: InternalExecutionResult[] },
    currentSequence: number,
    currentSequenceGroupResults?: { [groupKey: string]: InternalExecutionResult[] },
    currentParallelGroup?: string,
    contextFromSteps?: string[],
    allResults?: InternalExecutionResult[]
  ): string {
    const contextParts: string[] = [];
    
    // If specific step IDs are requested, use those exclusively
    if (contextFromSteps && contextFromSteps.length > 0 && allResults) {
      contextParts.push('--- Selected Step Results ---');
      
      for (const stepId of contextFromSteps) {
        const result = allResults.find(r => r.id === stepId);
        if (result && result.success) {
          const groupLabel = result.parallelGroup ? ` (${result.parallelGroup})` : '';
          const sequenceLabel = result.sequence !== undefined ? ` [seq:${result.sequence}]` : '';
          
          if (result.type === 'text' && result.response) {
            contextParts.push(`${stepId}${groupLabel}${sequenceLabel}: ${result.response}`);
          } else if (result.type === 'image' && result.imagePath) {
            contextParts.push(`${stepId}${groupLabel}${sequenceLabel}: [Image generated: ${result.imagePath}]`);
          }
        } else if (!result) {
          contextParts.push(`${stepId}: [Step not found or not yet executed]`);
        } else if (!result.success) {
          contextParts.push(`${stepId}: [Step failed: ${result.error || 'Unknown error'}]`);
        }
      }
      
      return contextParts.join('\n');
    }
    
    // Otherwise, use the default behavior: include all previous sequences and groups
    
    // Include results from all previous sequences
    for (let seq = 0; seq < currentSequence; seq++) {
      const sequenceResults = previousResults instanceof Map ? previousResults.get(seq) : previousResults[seq];
      if (sequenceResults && sequenceResults.length > 0) {
        contextParts.push(`--- Sequence ${seq} Results ---`);
        sequenceResults.forEach((result, index) => {
          if (result.success) {
            const label = result.id ? `${result.id}` : `Step ${index + 1}`;
            const groupLabel = result.parallelGroup ? ` (${result.parallelGroup})` : '';
            
            if (result.type === 'text' && result.response) {
              contextParts.push(`${label}${groupLabel}: ${result.response}`);
            } else if (result.type === 'image' && result.imagePath) {
              contextParts.push(`${label}${groupLabel}: [Image generated: ${result.imagePath}]`);
            }
          }
        });
        contextParts.push('');
      }
    }
    
    // Include results from previous parallel groups in the current sequence
    if (currentSequenceGroupResults && currentParallelGroup) {
      for (const [groupKey, groupResults] of Object.entries(currentSequenceGroupResults)) {
        // Only include groups that come before the current group alphabetically
        if (groupKey !== 'default' && currentParallelGroup !== 'default' && groupKey >= currentParallelGroup) {
          continue;
        }
        if (groupKey === currentParallelGroup) {
          continue; // Don't include current group
        }
        
        if (groupResults && groupResults.length > 0) {
          contextParts.push(`--- Sequence ${currentSequence}, Group ${groupKey} Results ---`);
          groupResults.forEach((result, index) => {
            if (result.success) {
              const label = result.id ? `${result.id}` : `Step ${index + 1}`;
              
              if (result.type === 'text' && result.response) {
                contextParts.push(`${label}: ${result.response}`);
              } else if (result.type === 'image' && result.imagePath) {
                contextParts.push(`${label}: [Image generated: ${result.imagePath}]`);
              }
            }
          });
          contextParts.push('');
        }
      }
    }
    
    return contextParts.join('\n');
  }

  /**
   * Build enhanced user prompt with context from previous results
   */
  buildUserPromptWithContext(
    originalPrompt: string,
    promptConfig: PromptConfig,
    executionContext: ExecutionContext
  ): string {
    let userPrompt = originalPrompt;
    
    // Add previous results as context if requested
    if (promptConfig.includePreviousResults) {
      const previousContext = this.buildPreviousResultsContext(
        executionContext.previousResults,
        promptConfig.sequence || 0,
        undefined, // currentSequenceGroupResults - would need to be passed in
        promptConfig.parallelGroup,
        promptConfig.contextFromSteps,
        executionContext.allResults
      );
      
      if (previousContext) {
        userPrompt = `Previous step results:\n${previousContext}\n\nCurrent prompt: ${originalPrompt}`;
      }
    }
    
    return userPrompt;
  }

  /**
   * Initialize execution context for batch processing
   */
  initializeExecutionContext(sessionId?: string, context?: any): ExecutionContext {
    return {
      sessionId,
      context,
      previousResults: new Map(),
      allResults: []
    };
  }

  /**
   * Update execution context with new results
   */
  updateExecutionContext(
    executionContext: ExecutionContext,
    sequence: number,
    results: InternalExecutionResult[]
  ): void {
    // Store results by sequence
    const currentSequenceResults = executionContext.previousResults.get(sequence) || [];
    currentSequenceResults.push(...results);
    executionContext.previousResults.set(sequence, currentSequenceResults);

    // Add to all results
    executionContext.allResults.push(...results);
  }
}