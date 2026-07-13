/**
 * Location: /src/ui/chat/services/MessageStreamHandler.ts
 *
 * Purpose: Consolidated streaming loop logic for AI responses
 * Extracted from MessageManager.ts to eliminate DRY violations (4+ repeated streaming patterns)
 *
 * ARCHITECTURE NOTE (Dec 2025):
 * A branch IS a conversation with parent metadata. When viewing a branch,
 * the branch is set as currentConversation. This means all streaming saves
 * go through ChatService.updateConversation() - no special routing needed.
 *
 * Used by: MessageManager, MessageAlternativeService for streaming AI responses
 * Dependencies: ChatService
 */

import { ChatService } from '../../../services/chat/ChatService';
import { ConversationData, ToolCall as ConversationToolCall } from '../../../types/chat/ChatTypes';

interface StreamToolCall {
  id: string;
  type?: string;
  name?: string;
  displayName?: string;
  technicalName?: string;
  function: {
    name: string;
    arguments: string;
  };
  result?: unknown;
  success?: boolean;
  error?: string;
  status?: string;
  isVirtual?: boolean;
  providerExecuted?: boolean;
  isComplete?: boolean;
  parameters?: unknown;
}

export interface StreamHandlerEvents {
  onStreamingUpdate: (messageId: string, content: string, isComplete: boolean, isIncremental?: boolean) => void;
  onToolCallsDetected: (messageId: string, toolCalls: StreamToolCall[]) => void;
  onReasoningUpdate?: (messageId: string, reasoningText: string, isComplete: boolean) => void;
}

export interface StreamOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
  messageId?: string;
  excludeFromMessageId?: string;
  abortSignal?: AbortSignal;
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
  temperature?: number;
  imageProvider?: 'google' | 'openrouter';
  imageModel?: string;
  transcriptionProvider?: string;
  transcriptionModel?: string;
}

export interface StreamResult {
  streamedContent: string;
  toolCalls?: StreamToolCall[];
  reasoning?: string;  // Accumulated reasoning text
  metadata?: Record<string, unknown>;
  usage?: {            // Token usage for context tracking
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  provider?: string;   // Resolved provider from final chunk
  model?: string;      // Resolved model from final chunk
  cost?: { totalCost: number; currency: string };
}

function toConversationToolCall(toolCall: StreamToolCall): ConversationToolCall {
  return {
    id: toolCall.id,
    type: 'function',
    name: toolCall.name,
    displayName: toolCall.displayName,
    technicalName: toolCall.technicalName,
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments
    },
    result: toolCall.result,
    success: toolCall.success,
    error: toolCall.error,
    providerExecuted: toolCall.providerExecuted,
    parameters: toolCall.parameters && typeof toolCall.parameters === 'object'
      ? (toolCall.parameters as Record<string, unknown>)
      : undefined
  };
}

/**
 * Handles streaming of AI responses with unified logic
 */
export class MessageStreamHandler {
  constructor(
    private chatService: ChatService,
    private events: StreamHandlerEvents
  ) {}

  /**
   * Stream AI response with consolidated logic
   * This eliminates the 4+ repeated streaming loop patterns in MessageManager
   */
  async streamResponse(
    conversation: ConversationData,
    userMessageContent: string,
    aiMessageId: string,
    options: StreamOptions
  ): Promise<StreamResult> {
    let streamedContent = '';
    let toolCalls: StreamToolCall[] | undefined = undefined;
    let hasStartedStreaming = false;
    let finalUsage: StreamResult['usage'] | undefined = undefined;
    let finalMetadata: Record<string, unknown> | undefined = undefined;
    let resolvedProvider: string | undefined = undefined;
    let resolvedModel: string | undefined = undefined;
    let finalCost: StreamResult['cost'] | undefined = undefined;

    // Reasoning accumulation
    let reasoningAccumulator = '';

    // Stream the AI response
    for await (const chunk of this.chatService.generateResponseStreaming(
      conversation.id,
      userMessageContent,
      {
        ...options,
        messageId: aiMessageId
      }
    )) {
      // Handle token chunks
      if (chunk.chunk) {
        streamedContent += chunk.chunk;

        // Update message in conversation object progressively
        // This ensures partial content is preserved if user stops generation
        const messageIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
        if (messageIndex >= 0) {
          // Update state to streaming on first chunk
          if (!hasStartedStreaming) {
            hasStartedStreaming = true;
            conversation.messages[messageIndex].state = 'streaming';
            conversation.messages[messageIndex].isLoading = false;
          }
          // Always update content so it's available on abort
          conversation.messages[messageIndex].content = streamedContent;
        }

        // Send only the new chunk to UI for incremental updates
        this.events.onStreamingUpdate(aiMessageId, chunk.chunk, false, true);
      }

      // Handle reasoning/thinking content (Claude, GPT-5, Gemini)
      if (chunk.reasoning) {
        reasoningAccumulator += chunk.reasoning;

        // Push the accumulated reasoning to the UI for live "Thinking" rendering
        this.events.onReasoningUpdate?.(aiMessageId, reasoningAccumulator, chunk.reasoningComplete || false);
      }

      // Mark reasoning as complete if signaled
      if (chunk.reasoningComplete) {
        this.events.onReasoningUpdate?.(aiMessageId, reasoningAccumulator, true);
      }

      // Extract tool calls when available
      if (chunk.toolCalls) {
        toolCalls = chunk.toolCalls;

        // Emit tool calls event for final chunk
        if (chunk.complete) {
          this.events.onToolCallsDetected(aiMessageId, toolCalls);
        }
      }

      // Capture usage data when available
      if (chunk.usage) {
        finalUsage = {
          promptTokens: chunk.usage.promptTokens || 0,
          completionTokens: chunk.usage.completionTokens || 0,
          totalTokens: chunk.usage.totalTokens || 0
        };
      }

      if (chunk.metadata) {
        finalMetadata = {
          ...(finalMetadata || {}),
          ...chunk.metadata
        };
      }

      // Capture provider/model/cost from final chunk (yielded by StreamingResponseService)
      if (chunk.complete) {
        if (chunk.provider) resolvedProvider = chunk.provider;
        if (chunk.model) resolvedModel = chunk.model;
        if (chunk.cost) finalCost = chunk.cost;
      }

      // Handle completion
      if (chunk.complete) {
        // Check if this is TRULY the final complete
        const hasToolCalls = toolCalls && toolCalls.length > 0;
        const toolCallsHaveResults = !!toolCalls?.length && toolCalls.some((tc) =>
          tc.result !== undefined || tc.success !== undefined
        );
        const isFinalComplete = !hasToolCalls || toolCallsHaveResults;

        if (isFinalComplete) {
          // Update conversation with final content + provider/model/cost
          const placeholderMessageIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
          if (placeholderMessageIndex >= 0) {
            conversation.messages[placeholderMessageIndex] = {
              ...conversation.messages[placeholderMessageIndex],
            content: streamedContent,
            state: 'complete',
            // Clear the loading spinner on completion. Without this, a
            // complete-but-empty stream (no token ever arrived) leaves the
            // placeholder's isLoading:true and the chat spins forever, because
            // isLoading is otherwise only cleared on the first token
            // (issue #271, claim b).
            isLoading: false,
            toolCalls: toolCalls?.map(toConversationToolCall),
            // Persist reasoning for re-render from storage
            reasoning: reasoningAccumulator || undefined,
            metadata: finalMetadata,
            provider: resolvedProvider,
            model: resolvedModel,
            cost: finalCost,
            usage: finalUsage,
          };
        }

          // Send final complete content
          this.events.onStreamingUpdate(aiMessageId, streamedContent, true, false);
          break;
        } else {
          // Intermediate complete - waiting for tool execution results
        }
      }
    }

    // Post-loop safety net: if the loop exited without hitting isFinalComplete
    // (e.g., tool execution error yielded complete:true with raw tool calls),
    // ensure the in-memory message reflects the final accumulated state.
    // This prevents the subsequent save from writing stale state to JSONL.
    const finalMessageIndex = conversation.messages.findIndex(msg => msg.id === aiMessageId);
    if (finalMessageIndex >= 0) {
      const finalMsg = conversation.messages[finalMessageIndex];
      if (finalMsg.state !== 'complete') {
        conversation.messages[finalMessageIndex] = {
          ...finalMsg,
          content: streamedContent,
          state: 'complete',
          // Safety-net terminal path: clear the spinner here too, so a stream
          // that exits without a final isFinalComplete (e.g. tool-execution
          // error yielding complete:true) never leaves isLoading:true stuck
          // (issue #271, claim b).
          isLoading: false,
          toolCalls: toolCalls?.map(toConversationToolCall),
          reasoning: reasoningAccumulator || undefined,
          metadata: finalMetadata,
          provider: resolvedProvider,
          model: resolvedModel,
          cost: finalCost,
          usage: finalUsage,
        };
      }
    }

    return {
      streamedContent,
      toolCalls,
      reasoning: reasoningAccumulator || undefined,
      metadata: finalMetadata,
      usage: finalUsage,
      provider: resolvedProvider,
      model: resolvedModel,
      cost: finalCost,
    };
  }

  /**
   * Stream response and save to storage
   * Convenience method that combines streaming and saving
   *
   * ARCHITECTURE NOTE (Dec 2025):
   * The conversation passed here is the currentConversation, which is
   * either a parent conversation or a branch (branch IS a conversation).
   * ChatService.updateConversation handles both the same way.
   */
  async streamAndSave(
    conversation: ConversationData,
    userMessageContent: string,
    aiMessageId: string,
    options: StreamOptions
  ): Promise<StreamResult> {
    const result = await this.streamResponse(conversation, userMessageContent, aiMessageId, options);

    // Save conversation to storage (works for both parent and branch)
    await this.chatService.updateConversation(conversation);

    return result;
  }
}
