/**
 * ToolContinuationService - Tool execution and pingpong loop management
 *
 * Handles the complete tool execution lifecycle:
 * - Initial tool call execution via MCP
 * - Building tool results for continuation
 * - Recursive tool call handling (pingpong pattern)
 * - Tool iteration limits and safety guards
 * - Dynamic tool schema merging from get_tools
 */

import { BaseAdapter } from '../adapters/BaseAdapter';
import { ConversationContextBuilder } from '../../chat/ConversationContextBuilder';
import { MCPToolExecution, IToolExecutor, ToolResult } from '../adapters/shared/ToolExecutionUtils';
import { Tool, TokenUsage, SupportedProvider, ToolCall as AdapterToolCall } from '../adapters/types';
import { ToolCall as ChatToolCall } from '../../../types/chat/ChatTypes';
import { checkForTerminalTool } from './TerminalToolHandler';
import {
  ProviderMessageBuilder,
  ConversationMessage,
  GenerateOptionsInternal,
  StreamingOptions
} from './ProviderMessageBuilder';

// Union type for tool calls from different sources
type ToolCallUnion = AdapterToolCall | ChatToolCall;

export interface StreamYield {
  chunk: string;
  complete: boolean;
  content: string;
  toolCalls?: ChatToolCall[];
  toolCallsReady?: boolean;
  usage?: TokenUsage;
  reasoning?: string;
  reasoningComplete?: boolean;
}

export class ToolContinuationService {
  // Safety limit for recursive tool calls
  private readonly TOOL_ITERATION_LIMIT = 15;

  constructor(
    private toolExecutor: IToolExecutor | undefined,
    private messageBuilder: ProviderMessageBuilder
  ) {}

  /**
   * Parse get_tools results and merge with existing tools
   */
  parseAndMergeTools(
    existingTools: Tool[],
    toolCalls: ToolCallUnion[],
    toolResults: ToolResult[]
  ): Tool[] {
    const newTools = [...existingTools];

    // Build a set of existing tool names for fast deduplication
    const existingNames = new Set<string>();
    for (const tool of existingTools) {
      const name = tool.function?.name;
      if (name) existingNames.add(name);
    }

    for (let i = 0; i < toolCalls.length; i++) {
      const toolCall = toolCalls[i];
      const result = toolResults[i];

      // Check if this was a get_tools call
      if (toolCall.function?.name === 'get_tools' && result?.success && result?.result?.tools) {
        const returnedTools = result.result.tools as Array<Tool | { name: string; description?: string; inputSchema?: Record<string, any> }>;

        // Handle both MCP format and OpenAI format tools
        for (const tool of returnedTools) {
          // Type guard to check if it's already a Tool type
          const isToolType = (t: typeof tool): t is Tool => 'type' in t && 'function' in t;

          // Extract tool name - handle both formats
          const toolName = isToolType(tool) ? tool.function?.name : 'name' in tool ? tool.name : undefined;

          if (!toolName) {
            continue;
          }

          // Skip if already exists
          if (existingNames.has(toolName)) {
            continue;
          }

          // Mark as added to prevent duplicates within this batch
          existingNames.add(toolName);

          // Normalize to Tool format
          if (isToolType(tool)) {
            newTools.push(tool);
          } else {
            // MCP format - convert
            newTools.push({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description || '',
                parameters: tool.inputSchema || { type: 'object', properties: {} }
              }
            });
          }
        }
      }
    }

    return newTools;
  }

  /**
   * Execute tools and build continuation stream (pingpong)
   */
  async* executeToolsAndContinue(
    adapter: BaseAdapter,
    provider: string,
    detectedToolCalls: ChatToolCall[],
    previousMessages: ConversationMessage[],
    userPrompt: string,
    generateOptions: GenerateOptionsInternal,
    options: StreamingOptions | undefined,
    initialUsage: TokenUsage | undefined
  ): AsyncGenerator<StreamYield, void, unknown> {
    let completeToolCallsWithResults: ChatToolCall[] = [];
    let toolIterationCount = 1;

    try {
      // Step 1: Execute tools via MCP to get results
      const mcpToolCalls = detectedToolCalls.map((tc) => ({
        id: tc.id,
        function: {
          name: tc.function?.name || tc.name || '',
          arguments: tc.function?.arguments || JSON.stringify(tc.parameters || {})
        }
      }));

      const toolResults = await MCPToolExecution.executeToolCalls(
        this.toolExecutor,
        mcpToolCalls,
        provider as SupportedProvider,
        generateOptions.onToolEvent,
        { sessionId: options?.sessionId, workspaceId: options?.workspaceId }
      );

      // Small delay to allow file system operations to complete (prevents race conditions)
      await new Promise(resolve => setTimeout(resolve, 100));

      // Build complete tool calls with execution results
      completeToolCallsWithResults = detectedToolCalls.map(originalCall => {
        const result = toolResults.find(r => r.id === originalCall.id);
        return {
          id: originalCall.id,
          type: originalCall.type || 'function',
          name: originalCall.function?.name || originalCall.name,
          parameters: JSON.parse(originalCall.function?.arguments || '{}'),
          result: result?.result,
          success: result?.success || false,
          error: result?.error,
          executionTime: result?.executionTime,
          function: originalCall.function
        };
      });

      // Step 1.5: Check for terminal tools (like subagent) that should stop the pingpong loop
      const terminalToolResult = checkForTerminalTool(completeToolCallsWithResults);
      if (terminalToolResult) {
        yield {
          chunk: terminalToolResult.message,
          complete: false,
          content: terminalToolResult.message,
          toolCalls: completeToolCallsWithResults
        };
        yield {
          chunk: '',
          complete: true,
          content: terminalToolResult.message,
          toolCalls: completeToolCallsWithResults,
          usage: initialUsage
        };
        return;
      }

      // Step 1.6: Parse get_tools results and update generateOptions BEFORE building continuation
      const beforeCount = generateOptions.tools?.length || 0;
      const updatedTools = this.parseAndMergeTools(
        generateOptions.tools || [],
        detectedToolCalls,
        toolResults
      );
      if (updatedTools.length > beforeCount) {
        generateOptions = { ...generateOptions, tools: updatedTools };
      }

      // Step 2: Build continuation for pingpong pattern
      const continuationOptions = this.messageBuilder.buildContinuationOptions(
        provider,
        userPrompt,
        detectedToolCalls,
        toolResults,
        previousMessages,
        generateOptions,
        options
      );

      // Step 3: Start NEW stream with continuation (pingpong)
      yield {
        chunk: '\n\n',
        complete: false,
        content: '\n\n',
        toolCalls: undefined
      };

      let fullContent = '\n\n';

      for await (const chunk of adapter.generateStreamAsync('', continuationOptions)) {
        if (chunk.content) {
          fullContent += chunk.content;

          yield {
            chunk: chunk.content,
            complete: false,
            content: fullContent,
            toolCalls: undefined
          };
        }

        // Handle recursive tool calls (another pingpong iteration)
        if (chunk.toolCalls) {
          const chatToolCalls: ChatToolCall[] = chunk.toolCalls.map(tc => ({
            ...tc,
            type: tc.type || 'function',
            function: tc.function || { name: '', arguments: '{}' }
          }));

          yield {
            chunk: '',
            complete: false,
            content: fullContent,
            toolCalls: chatToolCalls,
            toolCallsReady: chunk.complete || false
          };

          if (!chunk.complete) {
            continue;
          }

          // Update response ID BEFORE recursive call (OpenAI only)
          if (provider === 'openai' && chunk.metadata?.responseId) {
            this.messageBuilder.updateResponseId(options?.conversationId, chunk.metadata.responseId);
          }

          // Check iteration limit before recursing
          toolIterationCount++;
          if (toolIterationCount > this.TOOL_ITERATION_LIMIT) {
            yield* this.yieldToolLimitMessage(fullContent);
            break;
          }

          // Execute recursive tool calls
          yield* this.handleRecursiveToolCalls(
            adapter,
            provider,
            chatToolCalls,
            previousMessages,
            userPrompt,
            generateOptions,
            options,
            completeToolCallsWithResults
          );
        }

        if (chunk.complete) {
          break;
        }
      }

    } catch (toolError) {
      console.error('Streaming tool execution error:', {
        error: toolError,
        message: toolError instanceof Error ? toolError.message : String(toolError),
        stack: toolError instanceof Error ? toolError.stack : undefined
      });

      yield {
        chunk: `\n\n❌ Tool execution failed: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
        complete: true,
        content: `Tool execution failed: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
        toolCalls: undefined
      };
      return;
    }

    // Yield final completion with complete tool calls and usage
    yield {
      chunk: '',
      complete: true,
      content: '',
      toolCalls: completeToolCallsWithResults.length > 0 ? completeToolCallsWithResults : undefined,
      usage: initialUsage
    };
  }

  /**
   * Handle recursive tool calls within continuation stream
   */
  private async* handleRecursiveToolCalls(
    adapter: BaseAdapter,
    provider: string,
    recursiveToolCalls: ChatToolCall[],
    previousMessages: ConversationMessage[],
    userPrompt: string,
    generateOptions: GenerateOptionsInternal,
    options: StreamingOptions | undefined,
    completeToolCallsWithResults: ChatToolCall[]
  ): AsyncGenerator<StreamYield, void, unknown> {
    try {
      // Convert recursive tool calls to MCP format
      const recursiveMcpToolCalls = recursiveToolCalls.map((tc) => {
        let argumentsStr = '';

        if (tc.function?.arguments) {
          argumentsStr = tc.function.arguments;
        } else if (tc.parameters) {
          argumentsStr = JSON.stringify(tc.parameters);
        } else {
          argumentsStr = '{}';
        }

        return {
          id: tc.id,
          function: {
            name: tc.function?.name || tc.name || '',
            arguments: argumentsStr
          }
        };
      });

      const recursiveToolResults = await MCPToolExecution.executeToolCalls(
        this.toolExecutor,
        recursiveMcpToolCalls,
        provider as SupportedProvider,
        generateOptions.onToolEvent,
        { sessionId: options?.sessionId, workspaceId: options?.workspaceId }
      );

      // Small delay to allow file system operations to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Build complete tool calls with recursive results
      const recursiveCompleteToolCalls: ChatToolCall[] = recursiveToolCalls.map((tc, index) => ({
        ...tc,
        result: recursiveToolResults[index]?.result,
        success: recursiveToolResults[index]?.success || false,
        error: recursiveToolResults[index]?.error,
        executionTime: recursiveToolResults[index]?.executionTime
      }));

      // Add recursive results to complete tool calls
      completeToolCallsWithResults.push(...recursiveCompleteToolCalls);

      // Check for terminal tools - stop recursion if found
      const terminalToolResult = checkForTerminalTool(recursiveCompleteToolCalls);
      if (terminalToolResult) {
        yield {
          chunk: terminalToolResult.message,
          complete: false,
          content: terminalToolResult.message,
          toolCalls: completeToolCallsWithResults
        };
        yield {
          chunk: '',
          complete: true,
          content: terminalToolResult.message,
          toolCalls: completeToolCallsWithResults
        };
        return;
      }

      // Parse get_tools results and update generateOptions
      const beforeCount = generateOptions.tools?.length || 0;
      const updatedTools = this.parseAndMergeTools(
        generateOptions.tools || [],
        recursiveToolCalls,
        recursiveToolResults
      );
      if (updatedTools.length > beforeCount) {
        generateOptions = { ...generateOptions, tools: updatedTools };
      }

      // Build continuation for recursive pingpong
      const recursiveContinuationOptions = this.messageBuilder.buildContinuationOptions(
        provider,
        userPrompt,
        recursiveToolCalls,
        recursiveToolResults,
        previousMessages,
        generateOptions,
        options
      );

      // Update previousMessages with this tool execution for next recursion
      const updatedPreviousMessages = this.updatePreviousMessagesWithToolExecution(
        provider,
        previousMessages,
        recursiveToolCalls,
        recursiveToolResults
      );

      // Continue with another recursive stream
      yield {
        chunk: '\n\n',
        complete: false,
        content: '\n\n',
        toolCalls: undefined
      };

      let fullContent = '\n\n';
      let recursiveToolCallsDetected: ChatToolCall[] = [];

      for await (const recursiveChunk of adapter.generateStreamAsync('', recursiveContinuationOptions)) {
        if (recursiveChunk.content) {
          fullContent += recursiveChunk.content;
          yield {
            chunk: recursiveChunk.content,
            complete: false,
            content: fullContent,
            toolCalls: undefined
          };
        }

        // Handle nested recursive tool calls if any
        if (recursiveChunk.toolCalls) {
          const nestedChatToolCalls: ChatToolCall[] = recursiveChunk.toolCalls.map(tc => ({
            ...tc,
            type: tc.type || 'function',
            function: tc.function || { name: '', arguments: '{}' }
          }));

          yield {
            chunk: '',
            complete: false,
            content: fullContent,
            toolCalls: nestedChatToolCalls,
            toolCallsReady: recursiveChunk.complete || false
          };

          // Store for execution after stream completes
          if (recursiveChunk.complete && recursiveChunk.toolCallsReady) {
            recursiveToolCallsDetected = nestedChatToolCalls;
          }
        }

        if (recursiveChunk.complete) {
          // Update response ID for next continuation (OpenAI only)
          if (provider === 'openai' && recursiveChunk.metadata?.responseId) {
            this.messageBuilder.updateResponseId(options?.conversationId, recursiveChunk.metadata.responseId);
          }
          break;
        }
      }

      // If the recursive stream ended with tool calls, handle them (nested recursion)
      if (recursiveToolCallsDetected.length > 0) {
        yield* this.handleRecursiveToolCalls(
          adapter,
          provider,
          recursiveToolCallsDetected,
          updatedPreviousMessages,
          userPrompt,
          generateOptions,
          options,
          completeToolCallsWithResults
        );
      }

    } catch (recursiveError) {
      // Swallow expected errors during streaming (incomplete JSON)
    }
  }

  /**
   * Update previousMessages with the current tool execution
   */
  private updatePreviousMessagesWithToolExecution(
    provider: string,
    previousMessages: ConversationMessage[],
    toolCalls: ToolCallUnion[],
    toolResults: ToolResult[]
  ): ConversationMessage[] {
    const updatedMessages = ConversationContextBuilder.appendToolExecution(
      provider === 'anthropic' ? 'anthropic' :
      provider === 'google' ? 'google' :
      provider,
      toolCalls,
      toolResults,
      previousMessages
    );

    return updatedMessages as ConversationMessage[];
  }

  /**
   * Yield tool iteration limit message
   */
  private async* yieldToolLimitMessage(fullContent: string): AsyncGenerator<StreamYield, void, unknown> {
    const limitMessage = `\n\nTOOL_LIMIT_REACHED: You have used ${this.TOOL_ITERATION_LIMIT} tool iterations. You must now ask the user if they want to continue with more tool calls. Explain what you've accomplished so far and what you still need to do.`;
    yield {
      chunk: limitMessage,
      complete: false,
      content: fullContent + limitMessage,
      toolCalls: undefined
    };
  }
}
