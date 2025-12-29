/**
 * ConversationContextBuilder - Facade for provider-specific conversation context building
 *
 * This is a thin facade that delegates to provider-specific builders.
 * It maintains backwards compatibility with existing code while internally
 * using the Strategy pattern via the builders module.
 *
 * For direct access to builders, import from './builders' instead.
 *
 * Follows Facade Pattern - simple interface to complex subsystem.
 */

import { ConversationData, ToolCall } from '../../types/chat/ChatTypes';
import {
  getContextBuilder,
  getProviderCategory as getProviderCategoryFromFactory,
  ProviderCategory
} from './builders';
import type {
  LLMMessage,
  LLMToolCall,
  ToolExecutionResult
} from './builders/IContextBuilder';

export class ConversationContextBuilder {

  /**
   * Build LLM-ready conversation context from stored conversation data
   *
   * @param conversation - The stored conversation data with tool calls
   * @param provider - LLM provider (determines format)
   * @param systemPrompt - Optional system prompt to prepend
   * @param model - Optional model name (used for local providers to determine format)
   * @returns Properly formatted conversation messages for the LLM provider
   */
  static buildContextForProvider(
    conversation: ConversationData,
    provider: string,
    systemPrompt?: string,
    model?: string
  ): LLMMessage[] {
    const builder = getContextBuilder(provider, model);
    return builder.buildContext(conversation, systemPrompt);
  }

  /**
   * Build tool continuation context for streaming pingpong pattern
   *
   * After tools are executed during streaming, this builds the continuation
   * context to send back to the LLM for the next response.
   *
   * @param provider - LLM provider (determines format)
   * @param userPrompt - Original user prompt
   * @param toolCalls - Tool calls that were detected and executed
   * @param toolResults - Results from tool execution
   * @param previousMessages - Previous conversation messages (optional)
   * @param systemPrompt - System prompt for OpenAI-style providers (optional)
   * @param model - Optional model name (used for local providers to determine format)
   * @returns Continuation context (message array)
   */
  static buildToolContinuation(
    provider: string,
    userPrompt: string,
    toolCalls: LLMToolCall[],
    toolResults: ToolExecutionResult[],
    previousMessages?: LLMMessage[],
    systemPrompt?: string,
    model?: string
  ): LLMMessage[] {
    // Special case: OpenAI uses Responses API
    if (provider.toLowerCase() === 'openai') {
      throw new Error('OpenAI tool continuation should use buildResponsesAPIToolInput directly via StreamingOrchestrator');
    }

    const builder = getContextBuilder(provider, model);
    return builder.buildToolContinuation(userPrompt, toolCalls, toolResults, previousMessages, systemPrompt);
  }

  /**
   * Build Responses API tool input for OpenAI continuations
   * Converts tool results to ResponseInputItem.FunctionCallOutput format
   *
   * @param toolCalls - Tool calls that were executed
   * @param toolResults - Results from tool execution
   * @returns Array of FunctionCallOutput items for Responses API input
   */
  static buildResponsesAPIToolInput(
    toolCalls: LLMToolCall[],
    toolResults: ToolExecutionResult[]
  ): Array<{ type: 'function_call_output'; call_id: string; output: string }> {
    const items = toolResults.map((result, index) => {
      const toolCall = toolCalls[index];

      return {
        type: 'function_call_output' as const,
        call_id: toolCall.id,
        output: result.success
          ? JSON.stringify(result.result || {})
          : JSON.stringify({ error: result.error || 'Tool execution failed' })
      };
    });

    // Debug: Show what tool continuation we're building
    console.log('[LLM_DEBUG] buildResponsesAPIToolInput:');
    console.log('[LLM_DEBUG]   Tool calls received:', toolCalls.length);
    toolCalls.forEach((tc, i) => {
      console.log(`[LLM_DEBUG]   [${i}] call_id=${tc.id}, name=${tc.function?.name}`);
    });
    console.log('[LLM_DEBUG]   Output items:', JSON.stringify(items, null, 2));

    return items;
  }

  /**
   * Append tool execution to existing conversation history
   *
   * This method appends ONLY the tool call and results to previousMessages.
   * Unlike buildToolContinuation, it does NOT add the user message.
   *
   * Use this for accumulating conversation history during recursive tool calls.
   *
   * @param provider - Provider type (anthropic, google, openai-compatible)
   * @param toolCalls - Tool calls that were executed
   * @param toolResults - Results from tool execution
   * @param previousMessages - Existing conversation history (already contains user message)
   * @param model - Optional model name (used for local providers to determine format)
   * @returns Updated message array with tool execution appended
   */
  static appendToolExecution(
    provider: string,
    toolCalls: LLMToolCall[],
    toolResults: ToolExecutionResult[],
    previousMessages: LLMMessage[],
    model?: string
  ): LLMMessage[] {
    const builder = getContextBuilder(provider, model);
    return builder.appendToolExecution(toolCalls, toolResults, previousMessages);
  }

  /**
   * Get provider category for debugging/logging
   *
   * @param provider - Provider name
   * @param model - Optional model name (used for local providers)
   * @returns Category string
   */
  static getProviderCategory(provider: string, model?: string): ProviderCategory {
    return getProviderCategoryFromFactory(provider, model);
  }
}
