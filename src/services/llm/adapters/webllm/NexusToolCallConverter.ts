/**
 * NexusToolCallConverter
 *
 * Converts old-style tool calls (e.g., "contentManager_readContent") to the
 * new two-tool architecture format using useTool wrapper.
 *
 * Nexus models are fine-tuned on the full toolset and output tool calls
 * in the old format. This converter wraps them in useTool format so they
 * can be executed by the two-tool architecture.
 *
 * Old format:
 *   { name: "contentManager_readContent", arguments: "{\"path\": \"test.md\"}" }
 *
 * New format (useTool wrapper):
 *   {
 *     name: "toolManager_useTool",
 *     arguments: "{\"context\": {...}, \"calls\": [{\"agent\": \"contentManager\", \"tool\": \"readContent\", \"params\": {\"path\": \"test.md\"}}]}"
 *   }
 */

import { ToolCall } from '../types';

/**
 * Default context for Nexus tool calls
 * Nexus models don't provide context, so we use sensible defaults
 */
interface NexusDefaultContext {
  workspaceId: string;
  sessionId: string;
  memory: string;
  goal: string;
}

/**
 * Tool call in useTool format
 */
interface UseToolCall {
  agent: string;
  tool: string;
  params: Record<string, unknown>;
}

/**
 * Full useTool params structure
 */
interface UseToolParams {
  context: NexusDefaultContext;
  calls: UseToolCall[];
  strategy?: 'serial' | 'parallel';
}

/**
 * Known agents in the system - used to parse tool names
 * Format: agentName_toolName
 */
const KNOWN_AGENTS = [
  'toolManager',
  'agentManager',
  'contentManager',
  'commandManager',
  'vaultManager',
  'vaultLibrarian',
  'memoryManager',
];

export class NexusToolCallConverter {
  private defaultContext: NexusDefaultContext;
  private sessionId: string;

  constructor(sessionId?: string, workspaceId?: string) {
    this.sessionId = sessionId || `nexus_${Date.now()}`;
    this.defaultContext = {
      workspaceId: workspaceId || 'default',
      sessionId: this.sessionId,
      memory: 'Nexus local model session - tool calls converted from fine-tuned format',
      goal: 'Execute tool calls as requested by Nexus model',
    };
  }

  /**
   * Update the session/workspace context
   */
  updateContext(sessionId?: string, workspaceId?: string): void {
    if (sessionId) {
      this.sessionId = sessionId;
      this.defaultContext.sessionId = sessionId;
    }
    if (workspaceId) {
      this.defaultContext.workspaceId = workspaceId;
    }
  }

  /**
   * Check if a tool call is already in useTool format
   */
  isUseToolFormat(toolCall: ToolCall): boolean {
    const name = toolCall.function?.name || '';
    return name === 'toolManager_useTool' || name === 'toolManager.useTool';
  }

  /**
   * Check if a tool call is in old format (needs conversion)
   */
  needsConversion(toolCall: ToolCall): boolean {
    if (this.isUseToolFormat(toolCall)) {
      return false;
    }

    const name = toolCall.function?.name || '';

    // Skip getTools - Nexus doesn't need it
    if (name === 'toolManager_getTools' || name === 'toolManager.getTools') {
      return false;
    }

    // Check if it matches known agent pattern
    return this.parseToolName(name) !== null;
  }

  /**
   * Parse an old-style tool name into agent and tool components
   * Returns null if not a valid tool name
   */
  private parseToolName(name: string): { agent: string; tool: string } | null {
    // Try underscore format first: agentName_toolName
    for (const agent of KNOWN_AGENTS) {
      if (name.startsWith(agent + '_')) {
        const tool = name.slice(agent.length + 1);
        if (tool) {
          return { agent, tool };
        }
      }
    }

    // Try dot format: agentName.toolName
    for (const agent of KNOWN_AGENTS) {
      if (name.startsWith(agent + '.')) {
        const tool = name.slice(agent.length + 1);
        if (tool) {
          return { agent, tool };
        }
      }
    }

    return null;
  }

  /**
   * Convert a single tool call to useTool format
   */
  convertToUseTool(toolCall: ToolCall): ToolCall {
    // Already in useTool format
    if (this.isUseToolFormat(toolCall)) {
      return toolCall;
    }

    const name = toolCall.function?.name || '';
    const parsed = this.parseToolName(name);

    if (!parsed) {
      // Can't parse - return as-is
      return toolCall;
    }

    // Parse the original arguments
    let originalParams: Record<string, unknown> = {};
    try {
      const argsStr = toolCall.function?.arguments || '{}';
      originalParams = JSON.parse(argsStr);
    } catch {
      // Invalid JSON - use empty params
    }

    // Build useTool params
    const useToolParams: UseToolParams = {
      context: { ...this.defaultContext },
      calls: [
        {
          agent: parsed.agent,
          tool: parsed.tool,
          params: originalParams,
        },
      ],
    };

    // Return converted tool call
    return {
      id: toolCall.id,
      type: 'function',
      function: {
        name: 'toolManager_useTool',
        arguments: JSON.stringify(useToolParams),
      },
    };
  }

  /**
   * Convert multiple tool calls to useTool format
   * Optionally batch them into a single useTool call
   */
  convertToolCalls(toolCalls: ToolCall[], batch: boolean = false): ToolCall[] {
    if (!toolCalls || toolCalls.length === 0) {
      return [];
    }

    // Filter out getTools calls - Nexus doesn't need them
    const filteredCalls = toolCalls.filter(tc => {
      const name = tc.function?.name || '';
      return name !== 'toolManager_getTools' && name !== 'toolManager.getTools';
    });

    if (filteredCalls.length === 0) {
      return [];
    }

    // If not batching, convert each call individually
    if (!batch) {
      return filteredCalls.map(tc => this.convertToUseTool(tc));
    }

    // Batch mode: combine all calls into a single useTool call
    const allCalls: UseToolCall[] = [];

    for (const toolCall of filteredCalls) {
      // If already useTool format, extract its calls
      if (this.isUseToolFormat(toolCall)) {
        try {
          const params = JSON.parse(toolCall.function?.arguments || '{}');
          if (params.calls && Array.isArray(params.calls)) {
            allCalls.push(...params.calls);
          }
        } catch {
          // Invalid JSON - skip
        }
        continue;
      }

      // Convert old-style call
      const name = toolCall.function?.name || '';
      const parsed = this.parseToolName(name);

      if (parsed) {
        let originalParams: Record<string, unknown> = {};
        try {
          originalParams = JSON.parse(toolCall.function?.arguments || '{}');
        } catch {
          // Invalid JSON
        }

        allCalls.push({
          agent: parsed.agent,
          tool: parsed.tool,
          params: originalParams,
        });
      }
    }

    if (allCalls.length === 0) {
      return [];
    }

    // Return single batched useTool call
    const batchedParams: UseToolParams = {
      context: { ...this.defaultContext },
      calls: allCalls,
      strategy: allCalls.length > 1 ? 'serial' : undefined,
    };

    return [
      {
        id: `batch_${Date.now()}`,
        type: 'function',
        function: {
          name: 'toolManager_useTool',
          arguments: JSON.stringify(batchedParams),
        },
      },
    ];
  }

  /**
   * Static helper to check if a model uses the Nexus tool format
   * (for integration with WebLLMAdapter.usesToolCallsContentFormat)
   */
  static isNexusModel(modelId: string): boolean {
    const nexusKeywords = ['nexus', 'tools-sft', 'claudesidian'];
    const lowerModelId = modelId.toLowerCase();
    return nexusKeywords.some(keyword => lowerModelId.includes(keyword));
  }
}
