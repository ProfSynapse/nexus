/**
 * Location: /src/database/optimizations/BatchOperations.ts
 *
 * Batch processing utilities with progress tracking and error handling.
 * Optimizes large dataset operations by processing in configurable chunks.
 *
 * Patterns inspired by agentic-flow AgentDB batch processing strategies.
 *
 * Related Files:
 * - /src/database/sync/SyncCoordinator.ts - Uses batch processing for event application
 * - /src/database/storage/JSONLWriter.ts - Batch writes to JSONL files
 * - /src/database/storage/SQLiteCacheManager.ts - Batch cache updates
 */

/**
 * Options for batch processing operations
 */
export interface BatchOptions<T> {
  /** Number of items to process per batch */
  batchSize: number;
  /** Callback for progress updates */
  onProgress?: (completed: number, total: number, currentBatch: number) => void;
  /** Callback when a batch completes */
  onBatchComplete?: (batchNumber: number, batchResults: any[]) => void;
  /** Whether to stop on first error */
  stopOnError?: boolean;
  /** Delay between batches in ms (for rate limiting) */
  delayBetweenBatches?: number;
}

/**
 * Result of a batch operation
 */
export interface BatchResult<R> {
  success: boolean;
  totalProcessed: number;
  totalFailed: number;
  results: R[];
  errors: Array<{ index: number; item: any; error: Error }>;
  duration: number;
}

/**
 * Batch processing utilities for optimizing large dataset operations.
 *
 * Features:
 * - Configurable batch sizes
 * - Progress tracking callbacks
 * - Error handling with continue/stop options
 * - Rate limiting between batches
 * - Parallel execution with concurrency control
 *
 * @example Sequential batch processing
 * ```typescript
 * const result = await BatchOperations.executeBatch(
 *   items,
 *   async (item) => processItem(item),
 *   {
 *     batchSize: 100,
 *     onProgress: (completed, total) => console.log(`${completed}/${total}`),
 *     stopOnError: false
 *   }
 * );
 * ```
 *
 * @example Parallel batch processing
 * ```typescript
 * const result = await BatchOperations.executeParallel(
 *   items,
 *   async (item) => processItem(item),
 *   5 // max 5 concurrent operations
 * );
 * ```
 */
export class BatchOperations {
  /**
   * Execute an operation on items in batches with progress tracking.
   *
   * Processes items sequentially in batches, allowing for:
   * - Progress monitoring
   * - Per-batch completion callbacks
   * - Rate limiting between batches
   * - Graceful error handling
   *
   * @param items - Array of items to process
   * @param operation - Async function to execute on each item
   * @param options - Batch processing options
   * @returns Result object with success status, results, and errors
   */
  static async executeBatch<T, R>(
    items: T[],
    operation: (item: T, index: number) => Promise<R>,
    options: BatchOptions<T>
  ): Promise<BatchResult<R>> {
    const startTime = Date.now();
    const {
      batchSize,
      onProgress,
      onBatchComplete,
      stopOnError = false,
      delayBetweenBatches = 0
    } = options;

    const results: R[] = [];
    const errors: Array<{ index: number; item: T; error: Error }> = [];
    let totalProcessed = 0;
    let totalFailed = 0;

    const totalBatches = Math.ceil(items.length / batchSize);

    // Process each batch sequentially
    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      const start = batchNum * batchSize;
      const end = Math.min(start + batchSize, items.length);
      const batch = items.slice(start, end);
      const batchResults: R[] = [];

      // Process items in current batch
      for (let i = 0; i < batch.length; i++) {
        const globalIndex = start + i;
        try {
          const result = await operation(batch[i], globalIndex);
          results.push(result);
          batchResults.push(result);
          totalProcessed++;
        } catch (error) {
          totalFailed++;
          errors.push({
            index: globalIndex,
            item: batch[i],
            error: error instanceof Error ? error : new Error(String(error))
          });

          // Stop immediately if stopOnError is true
          if (stopOnError) {
            return {
              success: false,
              totalProcessed,
              totalFailed,
              results,
              errors,
              duration: Date.now() - startTime
            };
          }
        }
      }

      // Progress callback
      if (onProgress) {
        onProgress(totalProcessed + totalFailed, items.length, batchNum + 1);
      }

      // Batch complete callback
      if (onBatchComplete) {
        onBatchComplete(batchNum + 1, batchResults);
      }

      if (delayBetweenBatches > 0 && batchNum < totalBatches - 1) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }

    return {
      success: errors.length === 0,
      totalProcessed,
      totalFailed,
      results,
      errors,
      duration: Date.now() - startTime
    };
  }

  /**
   * Execute multiple operations in parallel with concurrency limit.
   *
   * Processes items in parallel chunks, respecting a maximum concurrency limit.
   * Useful for I/O-bound operations where parallel execution provides benefits.
   *
   * @param items - Array of items to process
   * @param operation - Async function to execute on each item
   * @param concurrency - Maximum number of concurrent operations (default: 5)
   * @returns Result object with success status, results, and errors
   */
  static async executeParallel<T, R>(
    items: T[],
    operation: (item: T, index: number) => Promise<R>,
    concurrency: number = 5
  ): Promise<BatchResult<R>> {
    const startTime = Date.now();
    const results: R[] = new Array(items.length);
    const errors: Array<{ index: number; item: T; error: Error }> = [];
    let totalProcessed = 0;
    let totalFailed = 0;

    // Process in chunks of concurrency size
    for (let i = 0; i < items.length; i += concurrency) {
      const chunk = items.slice(i, i + concurrency);
      const chunkPromises = chunk.map(async (item, chunkIndex) => {
        const globalIndex = i + chunkIndex;
        try {
          results[globalIndex] = await operation(item, globalIndex);
          totalProcessed++;
        } catch (error) {
          totalFailed++;
          errors.push({
            index: globalIndex,
            item,
            error: error instanceof Error ? error : new Error(String(error))
          });
        }
      });

      // Wait for all operations in this chunk to complete
      await Promise.all(chunkPromises);
    }

    return {
      success: errors.length === 0,
      totalProcessed,
      totalFailed,
      results: results.filter(r => r !== undefined),
      errors,
      duration: Date.now() - startTime
    };
  }

  /**
   * Execute operations with retry logic for failed items.
   *
   * Attempts to process all items, then retries failed items up to maxRetries times.
   * Useful for operations that may fail due to transient errors.
   *
   * @param items - Array of items to process
   * @param operation - Async function to execute on each item
   * @param options - Batch processing options
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   * @returns Result object with success status, results, and errors
   */
  static async executeBatchWithRetry<T, R>(
    items: T[],
    operation: (item: T, index: number) => Promise<R>,
    options: BatchOptions<T>,
    maxRetries: number = 3
  ): Promise<BatchResult<R>> {
    let result = await this.executeBatch(items, operation, options);
    let retryCount = 0;

    // Retry failed items
    while (result.errors.length > 0 && retryCount < maxRetries) {
      retryCount++;
      const failedItems = result.errors.map(e => e.item);
      const failedIndices = result.errors.map(e => e.index);

      // Clear previous errors
      result.errors = [];

      // Retry failed items
      const retryResult = await this.executeBatch(
        failedItems,
        operation,
        { ...options, stopOnError: false }
      );

      // Merge results
      retryResult.results.forEach((res, idx) => {
        const originalIndex = failedIndices[idx];
        result.results[originalIndex] = res;
        result.totalProcessed++;
        result.totalFailed--;
      });

      // Keep track of still-failed items
      result.errors = retryResult.errors.map((err, idx) => ({
        ...err,
        index: failedIndices[idx]
      }));
    }

    result.success = result.errors.length === 0;
    return result;
  }

  /**
   * Process items in batches with a transform function.
   *
   * Useful for data transformation pipelines where you want to process
   * large datasets in memory-efficient batches.
   *
   * @param items - Array of items to transform
   * @param transform - Transform function for each item
   * @param batchSize - Size of each batch
   * @returns Array of transformed results
   */
  static async transformBatch<T, R>(
    items: T[],
    transform: (item: T) => Promise<R>,
    batchSize: number = 100
  ): Promise<R[]> {
    const result = await this.executeBatch(
      items,
      (item) => transform(item),
      { batchSize, stopOnError: false }
    );
    return result.results;
  }

  /**
   * Split an array into batches of specified size.
   *
   * Utility function for manual batch processing.
   *
   * @param items - Array to split
   * @param batchSize - Size of each batch
   * @returns Array of batches
   */
  static splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }
}
