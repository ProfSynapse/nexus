import { RequestExecutor } from './RequestExecutor';
import { ContextBuilder } from './ContextBuilder';
import {
  PromptConfig,
  InternalExecutionResult,
  ExecutionContext
} from '../types';

/**
 * Service responsible for managing request execution sequences and parallel groups
 * Handles both text and image requests through RequestExecutor
 * Follows SRP by focusing only on execution orchestration logic
 */
export class SequenceManager {
  constructor(
    private requestExecutor: RequestExecutor,
    private contextBuilder: ContextBuilder
  ) {}

  /**
   * Execute prompts with sequence and parallel group support
   * - Sequences execute in numerical order (0, 1, 2, etc.)
   * - Within each sequence, parallel groups execute sequentially
   * - Prompts within the same parallel group execute concurrently
   */
  async executePromptsWithSequencing(
    prompts: PromptConfig[],
    executionContext: ExecutionContext
  ): Promise<InternalExecutionResult[]> {
    const results: InternalExecutionResult[] = [];
    
    // Group prompts by sequence number (default to 0 if not specified)
    const sequenceGroups = this.groupPromptsBySequence(prompts);
    
    // Sort sequences to execute in order
    const sortedSequences = Array.from(sequenceGroups.keys()).sort((a, b) => a - b);
    
    // Execute each sequence in order
    for (const sequence of sortedSequences) {
      const sequencePrompts = sequenceGroups.get(sequence)!;
      
      // Execute prompts within this sequence with parallel group support
      const sequenceResults = await this.executeSequenceWithParallelGroups(
        sequencePrompts,
        executionContext,
        sequence
      );
      
      results.push(...sequenceResults);
      
      // Update execution context with results from this sequence
      this.contextBuilder.updateExecutionContext(executionContext, sequence, sequenceResults);
    }
    
    return results;
  }

  /**
   * Execute a sequence with parallel group support
   * Groups prompts by parallelGroup and executes groups sequentially, prompts within groups concurrently
   */
  private async executeSequenceWithParallelGroups(
    prompts: PromptConfig[],
    executionContext: ExecutionContext,
    _currentSequence: number
  ): Promise<InternalExecutionResult[]> {
    const results: InternalExecutionResult[] = [];
    
    // Group prompts by parallelGroup within this sequence
    const parallelGroups = this.groupPromptsByParallelGroup(prompts);
    
    // Sort groups to ensure consistent execution order (default group first, then alphabetically)
    const sortedGroups = this.sortParallelGroups(Array.from(parallelGroups.keys()));
    
    // Execute each parallel group sequentially
    for (const groupKey of sortedGroups) {
      const groupPrompts = parallelGroups.get(groupKey)!;
      
      // Execute all requests in this group concurrently (text and image)
      const groupExecutionResults = await this.requestExecutor.executeRequestsInParallel(
        groupPrompts,
        executionContext,
        executionContext.sessionId
      );
      
      results.push(...groupExecutionResults);
      
      // Update context with results from this group
      executionContext.allResults.push(...groupExecutionResults);
    }
    
    return results;
  }

  /**
   * Group prompts by sequence number
   */
  private groupPromptsBySequence(prompts: PromptConfig[]): Map<number, PromptConfig[]> {
    const sequenceGroups = new Map<number, PromptConfig[]>();
    
    for (const prompt of prompts) {
      const sequence = prompt.sequence || 0;
      if (!sequenceGroups.has(sequence)) {
        sequenceGroups.set(sequence, []);
      }
      sequenceGroups.get(sequence)!.push(prompt);
    }
    
    return sequenceGroups;
  }

  /**
   * Group prompts by parallel group within a sequence
   */
  private groupPromptsByParallelGroup(prompts: PromptConfig[]): Map<string, PromptConfig[]> {
    const parallelGroups = new Map<string, PromptConfig[]>();
    
    for (const prompt of prompts) {
      const groupKey = prompt.parallelGroup || 'default';
      if (!parallelGroups.has(groupKey)) {
        parallelGroups.set(groupKey, []);
      }
      parallelGroups.get(groupKey)!.push(prompt);
    }
    
    return parallelGroups;
  }

  /**
   * Sort parallel groups to ensure consistent execution order
   * Default group executes first, then alphabetically
   */
  private sortParallelGroups(groupKeys: string[]): string[] {
    return groupKeys.sort((a, b) => {
      if (a === 'default' && b !== 'default') return -1;
      if (a !== 'default' && b === 'default') return 1;
      return a.localeCompare(b);
    });
  }

  /**
   * Get execution statistics from results (internal use only)
   */
  getExecutionStatistics(results: InternalExecutionResult[]) {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    const totalExecutionTime = results.reduce((sum, r) => sum + (r.executionTime || 0), 0);

    return {
      totalPrompts: results.length,
      successfulPrompts: successful.length,
      failedPrompts: failed.length,
      totalExecutionTimeMS: totalExecutionTime,
      avgExecutionTimeMS: results.length > 0 ? totalExecutionTime / results.length : 0
    };
  }
}