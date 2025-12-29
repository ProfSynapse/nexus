/**
 * ToolCallService - Manages tool calls, events, and execution for chat conversations
 *
 * Responsibilities:
 * - Tool initialization from DirectToolExecutor (or legacy MCPConnector)
 * - OpenAI format tool schemas
 * - Tool event callbacks (detected/updated/started/completed)
 * - Progressive tool call display coordination
 * - Tool execution via DirectToolExecutor
 * - Session/workspace context injection
 *
 * Architecture Note:
 * This service now uses DirectToolExecutor by default, which works on BOTH
 * desktop and mobile. MCPConnector is only needed for external clients
 * (Claude Desktop) and is kept for backward compatibility during migration.
 *
 * Follows Single Responsibility Principle - only handles tool management.
 */

import { ToolCall } from '../../types/chat/ChatTypes';
import { getToolNameMetadata } from '../../utils/toolNameUtils';
import { DirectToolExecutor } from './DirectToolExecutor';
import type { JSONSchema } from '../../types/schema/JSONSchemaTypes';

/** Tool event data passed to callbacks */
export interface ToolEventData {
  conversationId?: string;
  toolCall?: ToolCall | RawToolCall;
  isComplete?: boolean;
  displayName?: string;
  technicalName?: string;
  agentName?: string;
  actionName?: string;
  sessionId?: string;
  workspaceId?: string;
  result?: unknown;
  success?: boolean;
  error?: string;
}

export interface ToolEventCallback {
  (messageId: string, event: 'detected' | 'updated' | 'started' | 'completed', data: ToolEventData): void;
}

/** Raw tool call from LLM before processing */
interface RawToolCall {
  id: string;
  function?: {
    name: string;
    arguments: string;
  };
  name?: string;
  arguments?: string;
}

/** OpenAI-format tool definition */
interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: JSONSchema;
  };
}

/** MCP-format tool definition */
interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
}

export interface ToolExecutionContext {
  sessionId?: string;
  workspaceId?: string;
}

/** MCP connector interface for legacy tool execution */
interface MCPConnectorLike {
  getAvailableTools?: () => (MCPTool | OpenAITool)[];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export class ToolCallService {
  private availableTools: (MCPTool | OpenAITool)[] = [];
  private toolCallHistory = new Map<string, ToolCall[]>();
  private toolEventCallback?: ToolEventCallback;
  private detectedToolIds = new Set<string>(); // Track which tools have been detected already
  private directToolExecutor?: DirectToolExecutor;

  constructor(
    private mcpConnector?: MCPConnectorLike // Now optional - only for legacy/Claude Desktop
  ) {}

  /**
   * Set the DirectToolExecutor for direct tool execution
   * This enables tools on ALL platforms (desktop + mobile)
   */
  setDirectToolExecutor(executor: DirectToolExecutor): void {
    this.directToolExecutor = executor;
    // Invalidate cached tools to force refresh
    this.availableTools = [];
  }

  /**
   * Get the DirectToolExecutor (for use by MCPToolExecution)
   */
  getDirectToolExecutor(): DirectToolExecutor | undefined {
    return this.directToolExecutor;
  }

  /**
   * Initialize available tools
   * Uses DirectToolExecutor (preferred) or falls back to MCPConnector (legacy)
   */
  async initialize(): Promise<void> {
    try {
      // Prefer DirectToolExecutor - works on ALL platforms
      if (this.directToolExecutor) {
        this.availableTools = await this.directToolExecutor.getAvailableTools() as (MCPTool | OpenAITool)[];
        return;
      }

      // Fallback to MCPConnector (legacy - only works on desktop)
      if (this.mcpConnector && typeof this.mcpConnector.getAvailableTools === 'function') {
        // MCP connector returns tools in MCP or OpenAI format
        const tools = this.mcpConnector.getAvailableTools();
        this.availableTools = (tools || []) as (MCPTool | OpenAITool)[];
        return;
      }

      this.availableTools = [];
    } catch (error) {
      console.error('[ToolCallService] Failed to initialize tools:', error);
      this.availableTools = [];
    }
  }

  /**
   * Get available tools in OpenAI format
   */
  getAvailableTools(): OpenAITool[] {
    return this.convertMCPToolsToOpenAIFormat(this.availableTools);
  }

  /**
   * Convert MCP tools (with inputSchema) to OpenAI format (with parameters)
   * Handles both MCP format and already-converted OpenAI format
   */
  private convertMCPToolsToOpenAIFormat(mcpTools: (MCPTool | OpenAITool)[]): OpenAITool[] {
    return mcpTools.map(tool => {
      // Check if already in OpenAI format (has type: 'function' and function object)
      if ('type' in tool && tool.type === 'function' && 'function' in tool) {
        return tool as OpenAITool; // Already converted, return as-is
      }

      // Convert from MCP format (name, description, inputSchema) to OpenAI format
      const mcpTool = tool as MCPTool;
      return {
        type: 'function' as const,
        function: {
          name: mcpTool.name,
          description: mcpTool.description,
          parameters: mcpTool.inputSchema // MCP's inputSchema maps to OpenAI's parameters
        }
      };
    });
  }

  /**
   * Set tool event callback for live UI updates
   */
  setEventCallback(callback: ToolEventCallback): void {
    this.toolEventCallback = callback;
  }

  /**
   * Fire tool event callback if registered
   */
  fireToolEvent(messageId: string, event: 'detected' | 'updated' | 'started' | 'completed', data: ToolEventData): void {
    try {
      this.toolEventCallback?.(messageId, event, data);
    } catch (error) {
      console.error(`Tool event callback failed for ${event}:`, error);
    }
  }

  /**
   * Handle progressive tool call detection during streaming
   * Fires 'detected' event for new tools, 'updated' event for subsequent chunks
   */
  handleToolCallDetection(
    messageId: string,
    toolCalls: RawToolCall[],
    isComplete: boolean,
    conversationId: string
  ): void {
    if (!this.toolEventCallback || !toolCalls) return;

    for (const tc of toolCalls) {
      const toolId = tc.id;

      // Determine if this is the first time we've seen this tool call
      const isFirstDetection = !this.detectedToolIds.has(toolId);

      const nameMetadata = getToolNameMetadata(
        tc.function?.name || tc.name
      );

      // Build tool data for event
      const toolData = {
        conversationId,
        toolCall: tc,
        isComplete: isComplete,
        displayName: nameMetadata.displayName,
        technicalName: nameMetadata.technicalName,
        agentName: nameMetadata.agentName,
        actionName: nameMetadata.actionName
      };

      if (isFirstDetection) {
        // First time seeing this tool - fire 'detected' event
        this.fireToolEvent(messageId, 'detected', toolData);
        this.detectedToolIds.add(toolId);
      } else if (isComplete) {
        // Subsequent update with complete parameters - fire 'updated' event
        this.fireToolEvent(messageId, 'updated', toolData);
      }
      // Skip incomplete intermediate chunks (they would spam the UI)
    }
  }

  /**
   * Reset detected tool IDs (call when starting new message)
   */
  resetDetectedTools(): void {
    this.detectedToolIds.clear();
  }

  /**
   * Execute tool calls via MCPConnector
   * @deprecated Use LLMService streaming with tool execution instead
   */
  async executeToolCalls(
    toolCalls: RawToolCall[],
    context?: ToolExecutionContext
  ): Promise<ToolCall[]> {
    if (!this.mcpConnector) {
      throw new Error('MCPConnector not available. Use DirectToolExecutor instead.');
    }
    const executedCalls: ToolCall[] = [];

    for (const toolCall of toolCalls) {
      const nameMetadata = getToolNameMetadata(
        toolCall.function?.name || toolCall.name
      );
      try {

        // Fire 'started' event
        if (this.toolEventCallback) {
          this.fireToolEvent('', 'started', {
            toolCall,
            sessionId: context?.sessionId,
            workspaceId: context?.workspaceId,
            displayName: nameMetadata.displayName,
            technicalName: nameMetadata.technicalName,
            agentName: nameMetadata.agentName,
            actionName: nameMetadata.actionName
          });
        }

        // Extract parameters
        const args = typeof toolCall.function?.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments)
          : (toolCall.function?.arguments || {});

        // Enrich with context
        const enrichedArgs = this.enrichWithContext(args as Record<string, unknown>, context);

        // Get the tool name (ensure it's defined)
        const toolName = toolCall.function?.name || toolCall.name || 'unknown';

        // Execute via MCP
        const result = await this.mcpConnector.executeTool(
          toolName,
          enrichedArgs
        );

        const executed: ToolCall = {
          id: toolCall.id,
          type: 'function',
          name: nameMetadata.displayName || toolName,
          displayName: nameMetadata.displayName,
          technicalName: nameMetadata.technicalName,
          function: {
            name: toolName,
            arguments: JSON.stringify(enrichedArgs)
          },
          parameters: enrichedArgs,
          result: result,
          success: true
        };

        executedCalls.push(executed);

        // Fire 'completed' event
        if (this.toolEventCallback) {
          this.fireToolEvent('', 'completed', {
            toolCall: executed,
            result,
            displayName: nameMetadata.displayName,
            technicalName: nameMetadata.technicalName,
            agentName: nameMetadata.agentName,
            actionName: nameMetadata.actionName
          });
        }

      } catch (error) {
        const toolName = toolCall.function?.name || toolCall.name || 'unknown';
        console.error(`Tool execution failed for ${toolName}:`, error);

        const failed: ToolCall = {
          id: toolCall.id,
          type: 'function',
          name: nameMetadata.displayName || toolName,
          displayName: nameMetadata.displayName,
          technicalName: nameMetadata.technicalName,
          function: {
            name: toolName,
            arguments: toolCall.function?.arguments || JSON.stringify({})
          },
          parameters: typeof toolCall.function?.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : (toolCall.function?.arguments || {}),
          error: error instanceof Error ? error.message : String(error),
          success: false
        };

        executedCalls.push(failed);

        if (this.toolEventCallback) {
          this.fireToolEvent('', 'completed', {
            toolCall: failed,
            result: failed.error,
            displayName: nameMetadata.displayName,
            technicalName: nameMetadata.technicalName,
            agentName: nameMetadata.agentName,
            actionName: nameMetadata.actionName,
            success: false,
            error: failed.error
          });
        }
      }
    }

    return executedCalls;
  }

  /**
   * Enrich tool parameters with session and workspace context
   */
  private enrichWithContext(params: Record<string, unknown>, context?: ToolExecutionContext): Record<string, unknown> {
    if (!context) return params;

    const enriched = { ...params };

    // Inject sessionId if available and not already present
    if (context.sessionId && !enriched.sessionId) {
      enriched.sessionId = context.sessionId;
    }

    // Inject workspaceId if available and not already present
    if (context.workspaceId && !enriched.workspaceId) {
      enriched.workspaceId = context.workspaceId;
    }

    return enriched;
  }

  /**
   * Get tool call history for a message
   */
  getToolCallHistory(messageId: string): ToolCall[] | undefined {
    return this.toolCallHistory.get(messageId);
  }

  /**
   * Store tool call history for a message
   */
  setToolCallHistory(messageId: string, toolCalls: ToolCall[]): void {
    this.toolCallHistory.set(messageId, toolCalls);
  }

  /**
   * Clear tool call history
   */
  clearHistory(): void {
    this.toolCallHistory.clear();
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.availableTools = [];
    this.toolCallHistory.clear();
    this.toolEventCallback = undefined;
    this.detectedToolIds.clear();
  }
}
