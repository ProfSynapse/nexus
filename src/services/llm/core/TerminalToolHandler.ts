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

interface ToolManagerCall {
  agent?: string;
  tool?: string;
  params?: unknown;
}

interface ToolManagerParameters {
  calls?: ToolManagerCall[];
}

interface SubagentToolResultData {
  subagentId?: string;
  branchId?: string;
  status?: string;
  message?: string;
}

interface SubagentToolResult {
  success?: boolean;
  data?: SubagentToolResultData;
}

interface ToolManagerUseToolResult {
  success?: boolean;
  data?: {
    results?: SubagentToolResult[];
  };
}

interface SubagentToolParams {
  task?: string;
  tools?: Record<string, string[]>;
}

/**
 * List of tools that should terminate the pingpong loop
 * These tools spawn background processes and the parent should not continue
 */
const TERMINAL_TOOLS = ['subagent', 'promptManager_subagent', 'promptManager.subagent'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function getToolManagerParameters(value: unknown): ToolManagerParameters | undefined {
  if (!isRecord(value) || !Array.isArray(value.calls)) {
    return undefined;
  }

  const calls = value.calls.flatMap((call): ToolManagerCall[] => {
    if (!isRecord(call)) {
      return [];
    }

    return [{
      agent: typeof call.agent === 'string' ? call.agent : undefined,
      tool: typeof call.tool === 'string' ? call.tool : undefined,
      params: call.params,
    }];
  });

  return { calls };
}

function getSubagentToolResult(value: unknown): SubagentToolResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawData = isRecord(value.data) ? value.data : undefined;

  return {
    success: typeof value.success === 'boolean' ? value.success : undefined,
    data: rawData ? {
      subagentId: typeof rawData.subagentId === 'string' ? rawData.subagentId : undefined,
      branchId: typeof rawData.branchId === 'string' ? rawData.branchId : undefined,
      status: typeof rawData.status === 'string' ? rawData.status : undefined,
      message: typeof rawData.message === 'string' ? rawData.message : undefined,
    } : undefined,
  };
}

function getToolManagerUseToolResult(value: unknown): ToolManagerUseToolResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawData = isRecord(value.data) ? value.data : undefined;
  const rawResults = rawData?.results;
  const results = Array.isArray(rawResults)
    ? rawResults.flatMap((result): SubagentToolResult[] => {
      const typedResult = getSubagentToolResult(result);
      return typedResult ? [typedResult] : [];
    })
    : undefined;

  return {
    success: typeof value.success === 'boolean' ? value.success : undefined,
    data: results ? { results } : undefined,
  };
}

function getSubagentToolParams(value: unknown): SubagentToolParams | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawTools = value.tools;
  let tools: Record<string, string[]> | undefined;

  if (isRecord(rawTools)) {
    const entries = Object.entries(rawTools).flatMap(([agent, rawAgentTools]) => {
      if (!isStringArray(rawAgentTools)) {
        return [];
      }

      return [[agent, rawAgentTools] as const];
    });

    tools = entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  return {
    task: typeof value.task === 'string' ? value.task : undefined,
    tools,
  };
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
    let wrappedResult: SubagentToolResult | undefined;
    let wrappedParams: SubagentToolParams | undefined;

    if (toolName === 'toolManager_useTool' || toolName.endsWith('useTool')) {
      // Try to get params from multiple sources
      let params = getToolManagerParameters(toolCall.parameters);

      // If parameters is empty, try parsing from function.arguments
      if (!params?.calls && toolCall.function?.arguments) {
        try {
          params = getToolManagerParameters(JSON.parse(toolCall.function.arguments));
        } catch {
          // Ignore parse errors
        }
      }

      const calls = params?.calls ?? [];

      for (const [callIndex, call] of calls.entries()) {
        if (call.tool === 'subagent' || (call.agent === 'promptManager' && call.tool === 'subagent')) {
          isWrappedSubagent = true;
          wrappedParams = getSubagentToolParams(call.params);

          // Extract result from useTool's results array
          // Structure is: { success, data: { results: [...] } }
          const useToolResult = getToolManagerUseToolResult(toolCall.result);
          const resultsArray = useToolResult?.data?.results;

          // Find the subagent result by index (matching position in calls array)
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
      const result = isWrappedSubagent ? wrappedResult : getSubagentToolResult(toolCall.result);
      const params = isWrappedSubagent ? wrappedParams : getSubagentToolParams(toolCall.parameters);

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
