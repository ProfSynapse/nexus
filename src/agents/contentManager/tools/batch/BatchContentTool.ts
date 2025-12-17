/**
 * BatchContentTool - Orchestrator for batch content operations
 */

import { App } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { BatchContentParams, BatchContentResult } from '../../types';
import { MemoryService } from '../../../memoryManager/services/MemoryService';
import { parseWorkspaceContext, extractContextFromParams } from '../../../../utils/contextUtils';

import { OperationValidator } from './validation/OperationValidator';
import { BatchExecutor, ExecutionResult } from './execution/BatchExecutor';
import { SchemaBuilder } from '../../../../utils/schemas/SchemaBuilder';
import { addRecommendations, Recommendation } from '../../../../utils/recommendationUtils';
import { NudgeHelpers } from '../../../../utils/nudgeHelpers';

// Result type for processed operations
export interface ProcessedResult {
  success: boolean;
  error?: string;
  data?: any;
  type: "read" | "create" | "append" | "prepend" | "replace" | "replaceByLine" | "delete" | "findReplace";
  filePath: string;
}

/**
 * BatchContentTool - Orchestrates batch content operations
 */
export class BatchContentTool extends BaseTool<BatchContentParams, BatchContentResult> {
  private app: App;
  private memoryService: MemoryService | null = null;
  private operationValidator: OperationValidator;
  private batchExecutor: BatchExecutor;
  private schemaBuilder: SchemaBuilder;

  constructor(app: App, memoryService?: MemoryService | null | undefined) {
    super(
      'batchContent',
      'Batch Content Operations',
      'Execute multiple content operations in a batch',
      '1.0.0'
    );

    this.app = app;
    this.memoryService = memoryService || null;
    this.operationValidator = new OperationValidator();
    this.batchExecutor = new BatchExecutor(app);
    this.schemaBuilder = new SchemaBuilder();
  }

  async execute(params: BatchContentParams): Promise<BatchContentResult> {
    try {
      const { operations, workspaceContext } = params;

      // 1. Validate operations
      const validationResult = this.operationValidator.validateOperations(operations);
      if (!validationResult.success) {
        throw new Error(validationResult.error);
      }

      // 2. Execute operations
      const executionResults = await this.batchExecutor.executeOperations(operations);

      // 3. Process results (inlined from ResultCollector)
      const processedResults: ProcessedResult[] = executionResults.map(result => ({
        success: result.success,
        error: result.error,
        data: result.data,
        type: result.type as ProcessedResult['type'],
        filePath: result.filePath
      }));

      // 4. Record activity (inlined from ActivityRecorder)
      await this.recordActivity(params, processedResults);

      // 5. Prepare response
      const response = this.prepareResult(
        true,
        { results: processedResults },
        undefined,
        extractContextFromParams(params),
        parseWorkspaceContext(workspaceContext) || undefined
      );

      // 6. Generate nudges
      const nudges = this.generateBatchContentNudges(operations, processedResults);
      return addRecommendations(response, nudges);
    } catch (error: unknown) {
      return this.prepareResult(
        false,
        undefined,
        error instanceof Error ? error.message : String(error),
        extractContextFromParams(params),
        parseWorkspaceContext(params.workspaceContext) || undefined
      );
    }
  }

  /**
   * Record batch activity to workspace memory
   */
  private async recordActivity(params: BatchContentParams, results: ProcessedResult[]): Promise<void> {
    try {
      if (!this.memoryService) return;

      const parsedContext = parseWorkspaceContext(params.workspaceContext);
      if (!parsedContext?.workspaceId) return;

      const successfulOps = results.filter(r => r.success);
      const relatedFiles = successfulOps.map(r => r.filePath);
      const opTypes = [...new Set(successfulOps.map(r => r.type))];

      await this.memoryService.recordActivityTrace({
        workspaceId: parsedContext.workspaceId,
        type: 'batch_operation',
        content: `Batch: ${successfulOps.length} ops (${opTypes.join(', ')}) on ${relatedFiles.length} files`,
        timestamp: Date.now(),
        metadata: {
          tool: 'BatchContentMode',
          params: { operations: opTypes },
          result: { files: relatedFiles, count: successfulOps.length },
          relatedFiles
        },
        sessionId: params.context.sessionId || ''
      });
    } catch (error) {
      console.error('Error recording batch activity:', error);
    }
  }

  getParameterSchema(): any {
    return this.schemaBuilder.getParameterSchema();
  }

  getResultSchema(): any {
    return this.schemaBuilder.getResultSchema();
  }

  private generateBatchContentNudges(operations: any[], results: any[]): Recommendation[] {
    const nudges: Recommendation[] = [];
    const operationCounts = NudgeHelpers.countOperationsByType(operations);

    const batchReadNudge = NudgeHelpers.checkBatchReadOperations(operationCounts.read);
    if (batchReadNudge) nudges.push(batchReadNudge);

    const batchCreateNudge = NudgeHelpers.checkBatchCreateOperations(operationCounts.create);
    if (batchCreateNudge) nudges.push(batchCreateNudge);

    return nudges;
  }
}
