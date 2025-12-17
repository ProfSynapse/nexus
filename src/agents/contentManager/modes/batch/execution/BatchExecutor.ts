/**
 * BatchExecutor - Handles batch execution of content operations
 * Follows Single Responsibility Principle by focusing only on execution
 */

import { App } from 'obsidian';
import { ContentOperation } from '../../../types';
import { ContentOperations } from '../../../utils/ContentOperations';

export interface ExecutionResult {
  success: boolean;
  error?: string;
  data?: any;
  type: string;
  filePath: string;
}

/**
 * Service responsible for executing batch content operations
 * Follows SRP by focusing only on execution operations
 */
export class BatchExecutor {
  constructor(private app: App) {}

  /**
   * Execute an array of operations sequentially
   */
  async executeOperations(operations: ContentOperation[]): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    // Execute operations sequentially to avoid conflicts
    for (const operation of operations) {
      const result = await this.executeOperation(operation);
      results.push(result);
    }

    return results;
  }

  /**
   * Execute a single operation
   */
  private async executeOperation(operation: ContentOperation): Promise<ExecutionResult> {
    try {
      let result: any;

      switch (operation.type) {
        case 'read':
          result = await this.executeReadOperation(operation);
          break;
        case 'create':
          result = await this.executeCreateOperation(operation);
          break;
        case 'append':
          result = await this.executeAppendOperation(operation);
          break;
        case 'prepend':
          result = await this.executePrependOperation(operation);
          break;
        case 'replace':
          result = await this.executeReplaceOperation(operation);
          break;
        case 'replaceByLine':
          result = await this.executeReplaceByLineOperation(operation);
          break;
        case 'delete':
          result = await this.executeDeleteOperation(operation);
          break;
        case 'findReplace':
          result = await this.executeFindReplaceOperation(operation);
          break;
        default:
          throw new Error(`Unknown operation type: ${(operation as ContentOperation).type}`);
      }

      return {
        success: true,
        data: result,
        type: operation.type,
        filePath: operation.params.filePath
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        type: operation.type,
        filePath: operation.params.filePath || 'unknown'
      };
    }
  }

  /**
   * Execute read operation
   */
  private async executeReadOperation(operation: Extract<ContentOperation, { type: 'read' }>): Promise<any> {
    const { filePath, limit, offset, includeLineNumbers } = operation.params;
    
    if (typeof limit === 'number' && typeof offset === 'number') {
      const lines = await ContentOperations.readLines(
        this.app,
        filePath,
        offset,
        offset + limit - 1,
        includeLineNumbers
      );
      
      return {
        content: lines.join('\n'),
        filePath,
        lineNumbersIncluded: includeLineNumbers,
        startLine: offset,
        endLine: offset + limit - 1
      };
    } else if (includeLineNumbers) {
      const content = await ContentOperations.readContentWithLineNumbers(this.app, filePath);
      
      return {
        content,
        filePath,
        lineNumbersIncluded: true
      };
    } else {
      const content = await ContentOperations.readContent(this.app, filePath);
      
      return {
        content,
        filePath,
        lineNumbersIncluded: false
      };
    }
  }

  /**
   * Execute create operation
   */
  private async executeCreateOperation(operation: Extract<ContentOperation, { type: 'create' }>): Promise<any> {
    const { filePath, content } = operation.params;
    
    const file = await ContentOperations.createContent(this.app, filePath, content);
    
    return {
      filePath,
      created: file.stat.ctime
    };
  }

  /**
   * Execute append operation
   */
  private async executeAppendOperation(operation: Extract<ContentOperation, { type: 'append' }>): Promise<any> {
    const { filePath, content } = operation.params;
    
    return await ContentOperations.appendContent(this.app, filePath, content);
  }

  /**
   * Execute prepend operation
   */
  private async executePrependOperation(operation: Extract<ContentOperation, { type: 'prepend' }>): Promise<any> {
    const { filePath, content } = operation.params;
    
    return await ContentOperations.prependContent(this.app, filePath, content);
  }

  /**
   * Execute replace operation
   */
  private async executeReplaceOperation(operation: Extract<ContentOperation, { type: 'replace' }>): Promise<any> {
    const { filePath, oldContent, newContent, similarityThreshold = 0.95 } = operation.params;
    
    const replacements = await ContentOperations.replaceContent(
      this.app,
      filePath,
      oldContent,
      newContent,
      similarityThreshold
    );
    
    return {
      filePath,
      replacements
    };
  }

  /**
   * Execute replace by line operation
   */
  private async executeReplaceByLineOperation(operation: Extract<ContentOperation, { type: 'replaceByLine' }>): Promise<any> {
    const { filePath, startLine, endLine, newContent } = operation.params;
    
    const linesReplaced = await ContentOperations.replaceByLine(
      this.app,
      filePath,
      startLine,
      endLine,
      newContent
    );
    
    return {
      filePath,
      linesReplaced
    };
  }

  /**
   * Execute delete operation
   */
  private async executeDeleteOperation(operation: Extract<ContentOperation, { type: 'delete' }>): Promise<any> {
    const { filePath, content, similarityThreshold = 0.95 } = operation.params;
    
    const deletions = await ContentOperations.deleteContent(
      this.app,
      filePath,
      content,
      similarityThreshold
    );
    
    return {
      filePath,
      deletions
    };
  }

  /**
   * Execute find and replace operation
   */
  private async executeFindReplaceOperation(operation: Extract<ContentOperation, { type: 'findReplace' }>): Promise<any> {
    const { 
      filePath, 
      findText, 
      replaceText, 
      replaceAll = false, 
      caseSensitive = true, 
      wholeWord = false 
    } = operation.params;
    
    const replacements = await ContentOperations.findReplaceContent(
      this.app,
      filePath,
      findText,
      replaceText,
      replaceAll,
      caseSensitive,
      wholeWord
    );
    
    return {
      filePath,
      replacements,
      findText,
      replaceText
    };
  }

  /**
   * Get execution statistics
   */
  getExecutionStats(results: ExecutionResult[]): {
    totalOperations: number;
    successfulOperations: number;
    failedOperations: number;
    operationTypes: Record<string, number>;
    successRate: number;
  } {
    const stats = {
      totalOperations: results.length,
      successfulOperations: results.filter(r => r.success).length,
      failedOperations: results.filter(r => !r.success).length,
      operationTypes: {} as Record<string, number>,
      successRate: 0
    };

    for (const result of results) {
      stats.operationTypes[result.type] = (stats.operationTypes[result.type] || 0) + 1;
    }

    stats.successRate = stats.totalOperations > 0 ? stats.successfulOperations / stats.totalOperations : 0;

    return stats;
  }
}