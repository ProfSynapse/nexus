/**
 * tests/eval/LiveToolExecutor.ts — Real agent executor for live mode (stub).
 *
 * In live mode, tool calls are executed against real Nexus agents operating
 * on a test vault. This requires initializing the full agent stack, which
 * is complex — this file is a stub for now.
 *
 * TODO: Full implementation requires:
 * - Initializing AgentRegistrationService with a test vault
 * - Wiring ToolManager as the executor
 * - Setting up TestVaultManager for reset between scenarios
 */

import type { IToolExecutor, ToolResult, ToolExecutionContext } from '../../src/services/llm/adapters/shared/ToolExecutionUtils';
import type { ToolCall } from '../../src/services/llm/adapters/types';

export class LiveToolExecutor implements IToolExecutor {
  async executeToolCalls(
    toolCalls: ToolCall[],
    _context?: ToolExecutionContext,
    _onToolEvent?: (event: 'started' | 'completed', data: unknown) => void
  ): Promise<ToolResult[]> {
    // Stub: return error results indicating live mode is not yet implemented
    return toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function?.name || tc.name || 'unknown',
      success: false,
      error: 'Live mode not yet implemented — use mock mode',
    }));
  }
}
