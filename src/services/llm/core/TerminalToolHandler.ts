/**
 * TerminalToolHandler - Detects tools that should stop the pingpong loop
 *
 * Terminal tools (like subagent) start background processes where the parent
 * conversation should NOT continue with more tool calls or LLM responses.
 * Instead, we return a synthetic message informing the user about the spawned process.
 */

import { ToolCall as ChatToolCall } from '../../../types/chat/ChatTypes';

export interface TerminalToolResult {
  message: string;
  branchId?: string;
}

/**
 * List of tools that should terminate the pingpong loop
 * These tools spawn background processes and the parent should not continue
 */
const TERMINAL_TOOLS = ['subagent', 'agentManager_subagent', 'agentManager.subagent'];

/**
 * Check if any executed tool is a "terminal" tool that should stop the pingpong loop
 * @param toolCalls - The tool calls with their execution results
 * @returns Synthetic message to display, or null if no terminal tool found
 */
export function checkForTerminalTool(toolCalls: ChatToolCall[]): TerminalToolResult | null {
  for (const toolCall of toolCalls) {
    const toolName = toolCall.name || toolCall.function?.name || '';

    // Check for direct subagent calls
    const isDirectSubagent = TERMINAL_TOOLS.some(t => toolName.includes(t) || toolName.endsWith('subagent'));

    // Check for subagent wrapped in toolManager_useTool
    let isWrappedSubagent = false;
    let wrappedResult: any = null;
    let wrappedParams: any = null;

    if (toolName === 'toolManager_useTool' || toolName.endsWith('useTool')) {
      // Try to get params from multiple sources
      let params = toolCall.parameters as { calls?: Array<{ agent?: string; tool?: string; params?: any }> } | undefined;

      // If parameters is empty, try parsing from function.arguments
      if (!params?.calls && toolCall.function?.arguments) {
        try {
          const parsed = JSON.parse(toolCall.function.arguments);
          params = parsed;
        } catch {
          // Ignore parse errors
        }
      }

      const calls = params?.calls || [];

      for (const call of calls) {
        if (call.tool === 'subagent' || (call.agent === 'agentManager' && call.tool === 'subagent')) {
          isWrappedSubagent = true;
          wrappedParams = call.params;

          // Extract result from useTool's results array
          // Structure is: { success, data: { results: [...] } }
          const useToolResult = toolCall.result as {
            success?: boolean;
            data?: { results?: Array<{ success?: boolean; data?: any; agent?: string; tool?: string }> };
          } | undefined;
          const resultsArray = useToolResult?.data?.results;

          // Find the subagent result by index (matching position in calls array)
          const callIndex = calls.indexOf(call);
          if (resultsArray?.[callIndex]) {
            wrappedResult = resultsArray[callIndex];
          } else if (resultsArray?.[0]) {
            // Fallback to first result
            wrappedResult = resultsArray[0];
          }
          break;
        }
      }
    }

    if (isDirectSubagent || isWrappedSubagent) {
      // Get the appropriate result and params
      const result = isWrappedSubagent ? wrappedResult : toolCall.result as {
        success?: boolean;
        data?: {
          subagentId?: string;
          branchId?: string;
          status?: string;
          message?: string;
        };
      } | undefined;

      const params = isWrappedSubagent ? wrappedParams : toolCall.parameters as { task?: string; tools?: Record<string, string[]> } | undefined;

      if (result?.success && result?.data) {
        const { branchId } = result.data;

        // Build a clean message with the subagent info
        let terminalMessage = `\n\n✅ **Subagent Started**\n\n`;
        terminalMessage += `**Task:** ${params?.task || 'Task assigned'}\n\n`;

        const toolsParam = params?.tools as Record<string, string[]> | undefined;
        if (toolsParam && Object.keys(toolsParam).length > 0) {
          const toolsList = Object.entries(toolsParam)
            .map(([agent, tools]) => `- ${agent}: ${(tools as string[]).join(', ')}`)
            .join('\n');
          terminalMessage += `**Tools Handed Off:**\n${toolsList}\n\n`;
        }

        terminalMessage += `The subagent is now working autonomously. You can:\n`;
        terminalMessage += `- Continue chatting here while it works\n`;
        terminalMessage += `- Click "View Branch →" on the tool result above to see progress\n`;
        terminalMessage += `- Results will appear here when complete`;

        return { message: terminalMessage, branchId };
      }
    }
  }

  return null;
}

/**
 * Check if a tool name is a terminal tool
 * @param toolName - The name of the tool to check
 * @returns true if the tool is a terminal tool
 */
export function isTerminalTool(toolName: string): boolean {
  return TERMINAL_TOOLS.some(t => toolName.includes(t) || toolName.endsWith('subagent'));
}
