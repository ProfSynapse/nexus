/**
 * tests/eval/LiveToolExecutor.ts — Real agent executor for live mode.
 *
 * In live mode, tool calls are executed against real Nexus agents operating
 * on a test vault. The HeadlessAgentStack initializes ContentManager,
 * StorageManager, CanvasManager, SearchManager, and ToolManager against
 * a filesystem-backed TestVault.
 *
 * The two-tool architecture (getTools/useTools) is handled transparently:
 * when the LLM emits a getTools or useTools tool call, this executor
 * routes it through the real ToolManager.
 *
 * Also tracks captured calls for assertion checking by EvalRunner, matching
 * the interface of EvalToolExecutor.getCapturedCalls().
 */

import type { IToolExecutor, ToolResult, ToolExecutionContext } from '../../src/services/llm/adapters/shared/ToolExecutionUtils';
import type { ToolCall } from '../../src/services/llm/adapters/types';
import {
  createHeadlessAgentStack,
  HeadlessAgentStackResult,
} from './headless/HeadlessAgentStack';
import { TestVaultManager } from './headless/TestVaultManager';
import type { CapturedToolCall } from './types';

export interface LiveToolExecutorOptions {
  /** Absolute path to the test vault directory on disk. */
  testVaultPath: string;
  /** Name for the vault (defaults to 'test-vault'). */
  vaultName?: string;
}

export class LiveToolExecutor implements IToolExecutor {
  private stack: HeadlessAgentStackResult | null = null;
  private vaultManager: TestVaultManager;
  private options: LiveToolExecutorOptions;
  private capturedCalls: CapturedToolCall[] = [];

  constructor(options: LiveToolExecutorOptions) {
    this.options = options;
    this.vaultManager = new TestVaultManager(options.testVaultPath);
  }

  /**
   * Initialize the headless agent stack. Must be called before executeToolCalls.
   * Separated from constructor because agent initialization is async.
   */
  async initialize(): Promise<void> {
    this.stack = await createHeadlessAgentStack({
      basePath: this.options.testVaultPath,
      vaultName: this.options.vaultName,
    });
  }

  /**
   * Reset the test vault and reinitialize the agent stack.
   * Call between scenarios for isolation.
   */
  async reset(seedFiles?: Record<string, string>): Promise<void> {
    this.vaultManager.reset();
    if (seedFiles) {
      this.vaultManager.seed(seedFiles);
    }
    await this.initialize();
  }

  /** Access the vault manager for snapshot/restore. */
  getVaultManager(): TestVaultManager {
    return this.vaultManager;
  }

  /** Access the headless stack (for direct agent access in tests). */
  getStack(): HeadlessAgentStackResult | null {
    return this.stack;
  }

  /** Get all captured tool calls since last reset. Matches EvalToolExecutor API. */
  getCapturedCalls(): CapturedToolCall[] {
    return [...this.capturedCalls];
  }

  /** Clear captured calls (keep stack initialized). */
  resetCalls(): void {
    this.capturedCalls = [];
  }

  /**
   * IToolExecutor implementation — routes tool calls through the real agent stack.
   *
   * Handles the two-tool architecture:
   * - getTools → stack.getTools(parsed args)
   * - useTools → stack.useTools(parsed args), also captures inner domain calls
   * - Other tool names → error (should go through useTools in production)
   */
  async executeToolCalls(
    toolCalls: ToolCall[],
    _context?: ToolExecutionContext,
    onToolEvent?: (event: 'started' | 'completed', data: unknown) => void,
  ): Promise<ToolResult[]> {
    if (!this.stack) {
      throw new Error('LiveToolExecutor not initialized — call initialize() first');
    }

    const results: ToolResult[] = [];

    for (const tc of toolCalls) {
      const toolName = tc.function?.name || 'unknown';
      const toolId = tc.id;

      onToolEvent?.('started', { id: toolId, name: toolName });

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        results.push({
          id: toolId,
          name: toolName,
          success: false,
          error: `Failed to parse tool arguments: ${tc.function?.arguments}`,
        });
        onToolEvent?.('completed', { id: toolId, name: toolName, success: false });
        continue;
      }

      // Capture the meta-tool call
      this.capturedCalls.push({ name: toolName, args, id: toolId });

      try {
        if (toolName === 'getTools') {
          const result = await this.stack.getTools(args as never);
          results.push({
            id: toolId,
            name: toolName,
            success: result.success,
            result: result,
            error: result.error,
          });
        } else if (toolName === 'useTools') {
          // Also capture inner domain tool calls for assertions
          const calls = args.calls as Array<{ agent?: string; tool?: string; params?: unknown }> | undefined;
          if (calls) {
            for (const call of calls) {
              const innerName = call.agent && call.tool
                ? `${call.agent}_${call.tool}`
                : (call.tool ?? 'unknown');
              this.capturedCalls.push({
                name: innerName,
                args: (call.params ?? {}) as Record<string, unknown>,
                id: `${toolId}_inner_${innerName}`,
              });
            }
          }

          const result = await this.stack.useTools(args as never);
          results.push({
            id: toolId,
            name: toolName,
            success: result.success,
            result: result,
            error: result.error,
          });
        } else {
          results.push({
            id: toolId,
            name: toolName,
            success: false,
            error: `Unknown meta-tool "${toolName}". In live mode, domain tools must be called via useTools.`,
          });
        }
      } catch (error) {
        results.push({
          id: toolId,
          name: toolName,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      onToolEvent?.('completed', {
        id: toolId,
        name: toolName,
        success: results[results.length - 1].success,
      });
    }

    return results;
  }
}
