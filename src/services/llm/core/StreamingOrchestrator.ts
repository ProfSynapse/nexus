/**
 * StreamingOrchestrator - Manages streaming LLM responses with tool execution
 *
 * Handles the complete streaming lifecycle including:
 * - Initial stream generation
 * - Tool call detection during streaming
 * - Tool execution via MCP
 * - Recursive pingpong pattern (tool → execute → continue → stream)
 * - Tool iteration limits and safety guards
 * - Usage tracking and cost calculation callbacks
 *
 * Follows Single Responsibility Principle - only handles streaming orchestration.
 */

import { BaseAdapter } from '../adapters/BaseAdapter';
import { ConversationContextBuilder } from '../../chat/ConversationContextBuilder';
import { MCPToolExecution, IToolExecutor } from '../adapters/shared/ToolExecutionUtils';
import { LLMProviderSettings } from '../../../types';
import { IAdapterRegistry } from './AdapterRegistry';

export interface StreamingOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  tools?: any[];
  onToolEvent?: (event: 'started' | 'completed', data: any) => void;
  onUsageAvailable?: (usage: any, cost?: any) => void;
  sessionId?: string;
  workspaceId?: string;
  conversationId?: string; // Required for OpenAI Responses API response ID tracking
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  // Thinking/reasoning settings
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
}

export interface StreamYield {
  chunk: string;
  complete: boolean;
  content: string;
  toolCalls?: any[];
  toolCallsReady?: boolean;
  usage?: any;
  // Reasoning/thinking support (Claude, GPT-5, Gemini, etc.)
  reasoning?: string;           // Incremental reasoning text
  reasoningComplete?: boolean;  // True when reasoning finished
}

export class StreamingOrchestrator {
  // Safety limit for recursive tool calls
  private readonly TOOL_ITERATION_LIMIT = 15;

  // Track OpenAI response IDs for stateful continuations
  private conversationResponseIds: Map<string, string> = new Map();

  /**
   * Parse get_tools results and merge with existing tools
   * @private
   */
  private parseAndMergeTools(
    existingTools: any[],
    toolCalls: any[],
    toolResults: any[]
  ): any[] {
    const newTools = [...existingTools];

    // Build a set of existing tool names for fast deduplication
    const existingNames = new Set<string>();
    for (const tool of existingTools) {
      const name = tool.name || tool.function?.name;
      if (name) existingNames.add(name);
    }

    for (let i = 0; i < toolCalls.length; i++) {
      const toolCall = toolCalls[i];
      const result = toolResults[i];

      // Check if this was a get_tools call
      if (toolCall.function?.name === 'get_tools' && result?.success && result?.result?.tools) {
        const returnedTools = result.result.tools;

        // Handle both MCP format and OpenAI format tools
        for (const tool of returnedTools) {
          // Extract tool name - handle both formats
          const toolName = tool.name || tool.function?.name;

          if (!toolName) {
            console.warn('[StreamingOrchestrator] Skipping tool with no name:', tool);
            continue;
          }

          // Skip if already exists
          if (existingNames.has(toolName)) {
            continue;
          }

          // Mark as added to prevent duplicates within this batch
          existingNames.add(toolName);

          // Normalize to OpenAI Chat Completions format: {type, function: {name, description, parameters}}
          if (tool.function) {
            // Already in OpenAI format
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

  constructor(
    private adapterRegistry: IAdapterRegistry,
    private settings: LLMProviderSettings,
    private toolExecutor?: IToolExecutor
  ) {}

  /**
   * Primary method: orchestrate streaming response with tool execution
   * @param messages - Conversation message history
   * @param options - Streaming configuration
   * @returns AsyncGenerator yielding chunks and tool calls
   */
  async* generateResponseStream(
    messages: Array<{ role: string; content: string }>,
    options?: StreamingOptions
  ): AsyncGenerator<StreamYield, void, unknown> {
    try {
      // Validate settings
      if (!this.settings || !this.settings.defaultModel) {
        throw new Error('LLM service not properly configured - missing settings');
      }

      // Determine provider and model
      const provider = options?.provider || this.settings.defaultModel.provider;
      const model = options?.model || this.settings.defaultModel.model;

      // Get adapter
      const adapter = this.adapterRegistry.getAdapter(provider);
      if (!adapter) {
        const availableProviders = this.adapterRegistry.getAvailableProviders();
        console.error(`[StreamingOrchestrator] Provider '${provider}' not available. Available providers:`, availableProviders);
        throw new Error(`Provider not available: ${provider}. Available: [${availableProviders.join(', ')}]`);
      }

      // Get only the latest user message as the actual prompt
      const latestUserMessage = messages[messages.length - 1];
      const userPrompt = latestUserMessage?.role === 'user' ? latestUserMessage.content : '';

      // Check if this is a Google model
      // Note: OpenRouter always uses OpenAI format, even for Google models
      const isGoogleModel = provider === 'google';

      let generateOptions: any;

      if (isGoogleModel) {
        // For Google, build proper conversation history in Google format
        const googleConversationHistory: any[] = [];

        // Add all messages in Google format
        for (const msg of messages) {
          // Skip messages with empty content
          if (!msg.content || !msg.content.trim()) {
            continue;
          }

          if (msg.role === 'user') {
            googleConversationHistory.push({
              role: 'user',
              parts: [{ text: msg.content }]
            });
          } else if (msg.role === 'assistant') {
            googleConversationHistory.push({
              role: 'model',
              parts: [{ text: msg.content }]
            });
          }
        }

        generateOptions = {
          model,
          systemPrompt: options?.systemPrompt, // Google uses systemInstruction
          conversationHistory: googleConversationHistory, // Pass structured history
          tools: options?.tools,
          onToolEvent: options?.onToolEvent,
          onUsageAvailable: options?.onUsageAvailable,
          enableThinking: options?.enableThinking,
          thinkingEffort: options?.thinkingEffort
        };
      } else {
        // For other providers (OpenAI, Anthropic), use text-based system prompt
        const conversationHistory = this.buildConversationHistory(messages);

        const systemPrompt = [
          options?.systemPrompt || '',
          conversationHistory ? '\n=== Conversation History ===\n' + conversationHistory : ''
        ].filter(Boolean).join('\n');

        generateOptions = {
          model,
          systemPrompt: systemPrompt || options?.systemPrompt,
          tools: options?.tools,
          onToolEvent: options?.onToolEvent,
          onUsageAvailable: options?.onUsageAvailable,
          enableThinking: options?.enableThinking,
          thinkingEffort: options?.thinkingEffort
        };
      }

      // Store original messages for pingpong context (exclude the last user message which is userPrompt)
      const previousMessages = messages.slice(0, -1);

      // Execute initial stream and detect tool calls
      let fullContent = '';
      let detectedToolCalls: any[] = [];
      let finalUsage: any = undefined;

      // For Google, pass empty string as prompt since conversation is in conversationHistory
      // For other providers, pass the extracted userPrompt
      const promptToPass = isGoogleModel ? '' : userPrompt;

      for await (const chunk of adapter.generateStreamAsync(promptToPass, generateOptions)) {
        // Track usage from chunks
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }

        // Handle text content streaming
        if (chunk.content) {
          fullContent += chunk.content;

          // Yield each token as it arrives
          yield {
            chunk: chunk.content,
            complete: false,
            content: fullContent,
            toolCalls: undefined
          };
        }

        // Handle reasoning/thinking content (Claude, GPT-5, Gemini)
        if (chunk.reasoning) {
          yield {
            chunk: '',
            complete: false,
            content: fullContent,
            toolCalls: undefined,
            reasoning: chunk.reasoning,
            reasoningComplete: chunk.reasoningComplete
          };
        }

        // Handle dynamic tool call detection
        if (chunk.toolCalls) {
          // ALWAYS yield tool calls for progressive UI display
          yield {
            chunk: '',
            complete: false,
            content: fullContent,
            toolCalls: chunk.toolCalls,
            toolCallsReady: chunk.complete || false
          };

          // Only STORE tool calls for execution when streaming is COMPLETE
          if (chunk.complete) {
            detectedToolCalls = chunk.toolCalls;
          }
        }

        if (chunk.complete) {
          // Store OpenAI response ID for future continuations (uses conversationId, NOT sessionId)
          if (provider === 'openai' && chunk.metadata?.responseId && options?.conversationId) {
            this.conversationResponseIds.set(options.conversationId, chunk.metadata.responseId);
          }
          break;
        }
      }

      // If no tool calls detected, we're done
      if (detectedToolCalls.length === 0 || !generateOptions.tools || generateOptions.tools.length === 0) {
        yield {
          chunk: '',
          complete: true,
          content: fullContent,
          toolCalls: undefined,
          usage: finalUsage
        };
        return;
      }

      // Tool calls detected - execute tools and continue streaming (pingpong)
      yield* this.executeToolsAndContinue(
        adapter,
        provider,
        detectedToolCalls,
        previousMessages,
        userPrompt,
        generateOptions,
        options,
        finalUsage
      );

    } catch (error) {
      throw error;
    }
  }

  /**
   * Build conversation history string from messages
   * @private - Internal helper
   */
  private buildConversationHistory(messages: any[]): string {
    if (messages.length <= 1) {
      return '';
    }

    return messages.slice(0, -1).map((msg: any) => {
      if (msg.role === 'user') return `User: ${msg.content}`;
      if (msg.role === 'assistant') {
        if (msg.tool_calls) return `Assistant: [Calling tools: ${msg.tool_calls.map((tc: any) => tc.function.name).join(', ')}]`;
        return `Assistant: ${msg.content}`;
      }
      if (msg.role === 'tool') return `Tool Result: ${msg.content}`;
      if (msg.role === 'system') return `System: ${msg.content}`;
      return '';
    }).filter(Boolean).join('\n');
  }

  /**
   * Execute tools and build continuation stream (pingpong)
   * @private - Internal helper
   */
  private async* executeToolsAndContinue(
    adapter: BaseAdapter,
    provider: string,
    detectedToolCalls: any[],
    previousMessages: any[],
    userPrompt: string,
    generateOptions: any,
    options: StreamingOptions | undefined,
    initialUsage: any
  ): AsyncGenerator<StreamYield, void, unknown> {
    let completeToolCallsWithResults: any[] = [];
    let toolIterationCount = 1;

    try {
      // Step 1: Execute tools via MCP to get results
      const mcpToolCalls = detectedToolCalls.map((tc: any) => ({
        id: tc.id,
        function: {
          name: tc.function?.name || tc.name,
          arguments: tc.function?.arguments || JSON.stringify(tc.parameters || {})
        }
      }));

      const toolResults = await MCPToolExecution.executeToolCalls(
        this.toolExecutor,
        mcpToolCalls,
        provider as any,
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
          name: originalCall.function?.name || originalCall.name,
          parameters: JSON.parse(originalCall.function?.arguments || '{}'),
          result: result?.result,
          success: result?.success || false,
          error: result?.error,
          executionTime: result?.executionTime,
          function: originalCall.function
        };
      });

      // Step 1.5: Parse get_tools results and update generateOptions BEFORE building continuation
      // Universal for all providers - adapters handle format conversion
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
      const continuationOptions = this.buildContinuationOptions(
        provider,
        userPrompt,
        detectedToolCalls,
        toolResults,
        previousMessages,
        generateOptions,
        options
      );

      // Step 3: Start NEW stream with continuation (pingpong)
      // Add spacing before continuation response (for better formatting between tool executions)
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
          // ALWAYS yield tool calls for progressive UI display
          yield {
            chunk: '',
            complete: false,
            content: fullContent,
            toolCalls: chunk.toolCalls,
            toolCallsReady: chunk.complete || false
          };

          // CRITICAL: Only EXECUTE tool calls when stream is COMPLETE
          if (!chunk.complete) {
            continue;
          }

          // Update response ID BEFORE recursive call (OpenAI only - uses conversationId)
          if (provider === 'openai' && chunk.metadata?.responseId && options?.conversationId) {
            this.conversationResponseIds.set(options.conversationId, chunk.metadata.responseId);
          }

          // Check iteration limit before recursing
          toolIterationCount++;
          if (toolIterationCount > this.TOOL_ITERATION_LIMIT) {
            yield* this.yieldToolLimitMessage(fullContent);
            break;
          }

          // Execute recursive tool calls (will use updated responseId)
          yield* this.handleRecursiveToolCalls(
            adapter,
            provider,
            chunk.toolCalls,
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
      // Log tool execution errors (don't swallow them silently)
      console.error('Streaming tool execution error:', {
        error: toolError,
        message: toolError instanceof Error ? toolError.message : String(toolError),
        stack: toolError instanceof Error ? toolError.stack : undefined
      });

      // Yield error message to user
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
      content: '', // Content already yielded in chunks
      toolCalls: completeToolCallsWithResults.length > 0 ? completeToolCallsWithResults : undefined,
      usage: initialUsage
    };
  }

  /**
   * Handle recursive tool calls within continuation stream
   * @private - Internal helper
   */
  private async* handleRecursiveToolCalls(
    adapter: BaseAdapter,
    provider: string,
    recursiveToolCalls: any[],
    previousMessages: any[],
    userPrompt: string,
    generateOptions: any,
    options: StreamingOptions | undefined,
    completeToolCallsWithResults: any[]
  ): AsyncGenerator<StreamYield, void, unknown> {
    try {
      // Convert recursive tool calls to MCP format
      const recursiveMcpToolCalls = recursiveToolCalls.map((tc: any) => {
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
            name: tc.function?.name || tc.name,
            arguments: argumentsStr
          }
        };
      });

      const recursiveToolResults = await MCPToolExecution.executeToolCalls(
        this.toolExecutor,
        recursiveMcpToolCalls,
        provider as any,
        generateOptions.onToolEvent,
        { sessionId: options?.sessionId, workspaceId: options?.workspaceId }
      );

      // Small delay to allow file system operations to complete (prevents race conditions)
      await new Promise(resolve => setTimeout(resolve, 100));

      // Build complete tool calls with recursive results
      const recursiveCompleteToolCalls = recursiveToolCalls.map((tc, index) => ({
        ...tc,
        result: recursiveToolResults[index]?.result,
        success: recursiveToolResults[index]?.success || false,
        error: recursiveToolResults[index]?.error,
        executionTime: recursiveToolResults[index]?.executionTime
      }));

      // Add recursive results to complete tool calls
      completeToolCallsWithResults.push(...recursiveCompleteToolCalls);

      // Parse get_tools results and update generateOptions BEFORE building continuation
      // Universal for all providers - adapters handle format conversion
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
      const recursiveContinuationOptions = this.buildContinuationOptions(
        provider,
        userPrompt,
        recursiveToolCalls,
        recursiveToolResults,
        previousMessages,
        generateOptions,
        options
      );

      // Update previousMessages to include this tool execution for the NEXT recursion
      // This ensures the AI sees the full conversation history and doesn't repeat tool calls
      const updatedPreviousMessages = this.updatePreviousMessagesWithToolExecution(
        provider,
        previousMessages,
        recursiveToolCalls,
        recursiveToolResults
      );

      // Continue with another recursive stream
      // Add spacing before recursive response (for better formatting between tool executions)
      yield {
        chunk: '\n\n',
        complete: false,
        content: '\n\n',
        toolCalls: undefined
      };

      let fullContent = '\n\n';
      let recursiveToolCallsDetected: any[] = [];

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

        // Handle nested recursive tool calls if any (up to iteration limit)
        if (recursiveChunk.toolCalls) {
          yield {
            chunk: '',
            complete: false,
            content: fullContent,
            toolCalls: recursiveChunk.toolCalls,
            toolCallsReady: recursiveChunk.complete || false
          };

          // Store for execution after stream completes
          if (recursiveChunk.complete && recursiveChunk.toolCallsReady) {
            recursiveToolCallsDetected = recursiveChunk.toolCalls;
          }
        }

        if (recursiveChunk.complete) {
          // Update response ID for next continuation (OpenAI only - uses conversationId)
          if (provider === 'openai' && recursiveChunk.metadata?.responseId && options?.conversationId) {
            this.conversationResponseIds.set(options.conversationId, recursiveChunk.metadata.responseId);
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
          updatedPreviousMessages, // Use updated history with current tool execution
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
   * This accumulates conversation history so the AI doesn't repeat tool calls
   * @private - Internal helper
   */
  private updatePreviousMessagesWithToolExecution(
    provider: string,
    previousMessages: any[],
    toolCalls: any[],
    toolResults: any[]
  ): any[] {
    // Use appendToolExecution which does NOT add the user message
    // This is the architectural fix - we only append tool execution, not the full continuation

    const updatedMessages = ConversationContextBuilder.appendToolExecution(
      provider === 'anthropic' ? 'anthropic' :
      provider === 'google' ? 'google' :
      provider,
      toolCalls,
      toolResults,
      previousMessages
    );

    // Return the updated messages for next iteration
    // This accumulates: [previous messages, assistant with tool_use, user with tool_result]
    // NOTE: User message is NOT added here - it's already in previousMessages
    return updatedMessages;
  }

  /**
   * Build continuation options with provider-specific formatting
   * @private - Internal helper
   */
  private buildContinuationOptions(
    provider: string,
    userPrompt: string,
    toolCalls: any[],
    toolResults: any[],
    previousMessages: any[],
    generateOptions: any,
    options?: StreamingOptions
  ): any {
    // Check if this is an Anthropic model (direct only)
    // Note: OpenRouter always uses OpenAI format, even for Anthropic models
    const isAnthropicModel = provider === 'anthropic';

    // Check if this is a Google model (direct only)
    // Note: OpenRouter always uses OpenAI format, even for Google models
    const isGoogleModel = provider === 'google';

    if (isAnthropicModel) {
      // Build proper Anthropic messages with tool_use and tool_result blocks
      const conversationHistory = ConversationContextBuilder.buildToolContinuation(
        'anthropic', // Use 'anthropic' for proper message formatting
        userPrompt,
        toolCalls,
        toolResults,
        previousMessages,
        generateOptions.systemPrompt
      ) as any[];

      // IMPORTANT: Disable thinking for tool continuations
      // Anthropic requires assistant messages to start with a thinking block when thinking is enabled,
      // but we don't have access to the original thinking content here.
      // The thinking already happened in the initial response, so we disable it for continuations.
      // See: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
      return {
        ...generateOptions,
        conversationHistory,
        systemPrompt: generateOptions.systemPrompt,
        enableThinking: false // Disable thinking for tool continuations
      };
    } else if (isGoogleModel) {
      // Build proper Google/Gemini conversation history with functionCall and functionResponse
      const conversationHistory = ConversationContextBuilder.buildToolContinuation(
        'google',
        userPrompt,
        toolCalls,
        toolResults,
        previousMessages,
        generateOptions.systemPrompt
      ) as any[];

      return {
        ...generateOptions,
        conversationHistory,
        systemPrompt: generateOptions.systemPrompt
      };
    } else if (provider === 'openai') {
      // OpenAI uses Responses API with function_call_output items
      const toolInput = ConversationContextBuilder.buildResponsesAPIToolInput(
        toolCalls,
        toolResults
      );

      // Get previous response ID for this conversation (uses conversationId, NOT sessionId)
      const convId = options?.conversationId;
      const previousResponseId = convId
        ? this.conversationResponseIds.get(convId)
        : undefined;

      return {
        ...generateOptions,
        conversationHistory: toolInput, // ResponseInputItem[] for Responses API
        previousResponseId,
        systemPrompt: generateOptions.systemPrompt,
        tools: generateOptions.tools // Ensure tools are passed to continuation
      };
    } else {
      // Other OpenAI-compatible providers (groq, mistral, perplexity, requesty, openrouter)
      // These still use Chat Completions API message arrays
      const conversationHistory = ConversationContextBuilder.buildToolContinuation(
        provider,
        userPrompt,
        toolCalls,
        toolResults,
        previousMessages,
        generateOptions.systemPrompt
      ) as any[];

      return {
        ...generateOptions,
        conversationHistory,
        systemPrompt: generateOptions.systemPrompt
      };
    }
  }

  /**
   * Yield tool iteration limit message
   * @private - Internal helper
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
