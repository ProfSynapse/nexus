/**
 * TerminalToolHandler - Detects tools that should stop the pingpong loop
 *
 * Terminal tools (like subagent) start background processes where the parent
 * conversation should NOT continue with more tool calls or LLM responses.
 * Instead, we return a synthetic message informing the user about the spawned process.
 */

import { ToolCall as ChatToolCall } from '../../../types/chat/ChatTypes';
import { splitTopLevelSegments, tokenize } from '../../../agents/toolManager/services/ToolCliNormalizer';

export interface TerminalToolResult {
  message: string;
  branchId?: string;
}

/**
 * List of tools that should terminate the pingpong loop
 * These tools spawn background processes and the parent should not continue
 */
const TERMINAL_TOOLS = ['subagent', 'promptManager_subagent', 'promptManager.subagent'];

interface WrappedToolCallParams {
  task?: string;
  tools?: Record<string, string[]>;
  tool?: string;
}

interface WrappedToolCall {
  agent?: string;
  tool?: string;
  params?: WrappedToolCallParams;
}

interface TerminalSubagentResult {
  success?: boolean;
  data?: {
    subagentId?: string;
    branchId?: string;
    status?: string;
    message?: string;
  };
}

interface UseToolResult {
  success?: boolean;
  data?: {
    results?: TerminalSubagentResult[];
  };
}

function isWrappedToolCallParams(value: unknown): value is { calls?: WrappedToolCall[]; tool?: string } {
  return typeof value === 'object' && value !== null;
}

const PROMPT_AGENT_ALIASES = new Set(['prompt', 'prompt-manager', 'promptmanager']);

/**
 * Locate the subagent command inside a CLI `tool` string.
 * Returns the zero-based segment index matching `results[i]` from the
 * executor, or -1 if no subagent segment is present. Uses the shared
 * `splitTopLevelSegments` + `tokenize` helpers so quoted commas inside
 * flag values don't break segmentation.
 */
function findCliSubagentSegmentIndex(toolValue: unknown): number {
  if (typeof toolValue !== 'string') {
    return -1;
  }

  const segments = splitTopLevelSegments(toolValue);
  for (let i = 0; i < segments.length; i += 1) {
    const tokens = tokenize(segments[i]);
    if (tokens.length < 2) continue;
    const agentAlias = tokens[0].toLowerCase();
    const toolName = tokens[1].toLowerCase();
    if (PROMPT_AGENT_ALIASES.has(agentAlias) && toolName === 'subagent') {
      return i;
    }
  }

  return -1;
}

function extractCliTask(segment: string): string | undefined {
  const tokens = tokenize(segment);
  const taskIndex = tokens.findIndex(token => token === '--task');
  if (taskIndex === -1 || taskIndex + 1 >= tokens.length) {
    return undefined;
  }
  return tokens[taskIndex + 1];
}

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
    let wrappedResult: TerminalSubagentResult | null = null;
    let wrappedParams: WrappedToolCallParams | undefined;

    if (toolName === 'toolManager_useTool' || toolName === 'toolManager_useTools' || toolName.endsWith('useTool') || toolName.endsWith('useTools')) {
      // Try to get params from multiple sources
      let params = toolCall.parameters as { calls?: WrappedToolCall[]; tool?: string } | undefined;

      // If parameters is empty, try parsing from function.arguments
      if (!params?.calls && toolCall.function?.arguments) {
        try {
          const parsed = JSON.parse(toolCall.function.arguments) as unknown;
          if (isWrappedToolCallParams(parsed)) {
            params = parsed;
          }
        } catch {
          // Ignore parse errors
        }
      }

      const calls = params?.calls || [];

      if (calls.length > 0) {
        for (const call of calls) {
          if (call.tool === 'subagent' || (call.agent === 'promptManager' && call.tool === 'subagent')) {
            isWrappedSubagent = true;
            wrappedParams = call.params;

            // Extract result from useTool's results array
            // Structure is: { success, data: { results: [...] } }
            const useToolResult = toolCall.result as UseToolResult | undefined;
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
      } else if (typeof params?.tool === 'string') {
        const cliSubagentIndex = findCliSubagentSegmentIndex(params.tool);
        if (cliSubagentIndex !== -1) {
          isWrappedSubagent = true;
          const segments = splitTopLevelSegments(params.tool);
          const subagentSegment = segments[cliSubagentIndex] || '';
          wrappedParams = { task: extractCliTask(subagentSegment), tool: params.tool };
          const useToolResult = toolCall.result as UseToolResult | undefined;
          wrappedResult = useToolResult?.data?.results?.[cliSubagentIndex] || null;
        }
      }
    }

    if (isDirectSubagent || isWrappedSubagent) {
      // Get the appropriate result and params
      const result = isWrappedSubagent ? wrappedResult : toolCall.result as TerminalSubagentResult | undefined;

      const params = isWrappedSubagent ? wrappedParams : toolCall.parameters as WrappedToolCallParams | undefined;

      if (result?.success && result?.data) {
        const { branchId } = result.data;

        // Build a clean message with the subagent info
        let terminalMessage = `\n\n✅ **Subagent Started**\n\n`;
        terminalMessage += `**Task:** ${params?.task || 'Task assigned'}\n\n`;

        const toolsParam = params?.tools;
        if (toolsParam && Object.keys(toolsParam).length > 0) {
          const toolsList = Object.entries(toolsParam)
            .map(([agent, tools]) => `- ${agent}: ${tools.join(', ')}`)
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
