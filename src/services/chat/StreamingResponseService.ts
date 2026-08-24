/**
 * StreamingResponseService - Manages streaming response generation
 *
 * Responsibilities:
 * - Coordinate LLM streaming with tool execution
 * - Handle progressive tool call detection
 * - Integrate cost tracking during streaming
 * - Persist messages and usage data
 * - Build LLM context with conversation history
 * - Manage streaming lifecycle (start, chunk, complete, abort)
 *
 * This is the core streaming coordination layer that brings together:
 * - ToolCallService (tool detection/events)
 * - CostTrackingService (usage/cost calculation)
 * - LLMService (actual streaming)
 * - ConversationService (persistence)
 *
 * Follows Single Responsibility Principle - only handles streaming coordination.
 */

import { ConversationData, ConversationMessage, MessageCost } from '../../types/chat/ChatTypes';
import type { ConversationMessage as LLMConversationMessage } from '../llm/core/ProviderMessageBuilder';
import { ConversationContextBuilder } from './ConversationContextBuilder';
import { ToolCallService } from './ToolCallService';
import { CostTrackingService } from './CostTrackingService';
import type { MessageQueueService } from './MessageQueueService';
import { ContextBudgetService, type NormalizedTokenUsage } from './ContextBudgetService';
import { shouldPassToolSchemasToProvider } from '../llm/utils/ToolSchemaSupport';
import { ContextCompactionService } from './ContextCompactionService';
import type {
  ChatRuntimeEnvelope,
  ChatRuntimeEvent,
} from '../llm/runtime/ChatRuntimeEvent';
import {
  createInitialChatTurnState,
  reduceChatTurn,
  type ChatTurnState,
} from '../llm/runtime/ChatTurnReducer';
import type { ToolExecutionOrigin } from '../../types/tools/ToolOperationTypes';

export interface StreamingOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
  messageId?: string;
  operationOrigin?: ToolExecutionOrigin;
  operationScopeId?: string;
  abortSignal?: AbortSignal;
  excludeFromMessageId?: string; // Exclude this message and everything after from context (for retry)
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
  temperature?: number; // 0.0-1.0, controls randomness
  imageProvider?: 'google' | 'openrouter';
  imageModel?: string;
  transcriptionProvider?: string;
  transcriptionModel?: string;
}

export type StreamingChunk = ChatRuntimeEnvelope;

interface LLMDefaultModel {
  provider: string;
  model: string;
}

interface LLMServiceLike {
  getDefaultModel(): LLMDefaultModel;
  // Post-Phase-3: the signature matches LLMService.generateResponseStream exactly.
  // Previously narrowed to `{role, content}[]`, which hid type errors at the
  // boundary — notably, buildLLMMessages produced richer objects than the
  // duck type admitted, masking the vestigial remap we just removed.
  generateResponseStream(messages: LLMConversationMessage[], options: Record<string, unknown>): AsyncGenerator<ChatRuntimeEvent, void, unknown>;
}

interface ConversationServiceLike {
  getConversation(conversationId: string): Promise<ConversationData | null>;
  addMessage(params: { conversationId: string; role: string; content: string; id: string }): Promise<void>;
  updateConversation(conversationId: string, update: { messages?: ConversationMessage[]; metadata?: ConversationData['metadata'] }): Promise<void>;
}

export interface StreamingDependencies {
  llmService: LLMServiceLike;
  conversationService: ConversationServiceLike;
  toolCallService: ToolCallService;
  costTrackingService: CostTrackingService;
  messageQueueService?: MessageQueueService; // Optional: for subagent result queueing
}

export class StreamingResponseService {
  private currentProvider?: string;

  constructor(
    private dependencies: StreamingDependencies
  ) {}

  /**
   * Generate streaming response with full coordination
   *
   * Always loads conversation from storage to ensure fresh data with tool calls
   */
  async* generateResponse(
    conversationId: string,
    userMessage: string,
    options?: StreamingOptions
  ): AsyncGenerator<StreamingChunk, void, unknown> {
    // Notify queue service that generation is starting (pauses processing)
    void this.dependencies.messageQueueService?.onGenerationStart?.();
    const messageId = options?.messageId || `msg_${Date.now()}_ai`;
    let turnState = createInitialChatTurnState();
    let persistedProvider = options?.provider ?? 'unknown';
    let persistedModel = options?.model ?? 'unknown';

    try {
      // Get defaults from LLMService if user didn't select provider/model
      const defaultModel = this.dependencies.llmService.getDefaultModel();

      // Check if message already exists (retry case)
      const existingConv = await this.dependencies.conversationService.getConversation(conversationId);
      const messageExists = existingConv?.messages.some((m) => m.id === messageId);

      // Only create placeholder if message doesn't exist (prevents duplicate during retry)
      if (!messageExists) {
        await this.dependencies.conversationService.addMessage({
          conversationId,
          role: 'assistant',
          content: '', // Will be updated as streaming progresses
          id: messageId
        });
      }

      // Get provider for context building
      const provider = options?.provider || defaultModel.provider;
      persistedProvider = provider;
      this.currentProvider = provider; // Store for context building

      // ALWAYS load conversation from storage to get complete history including tool calls
      const conversation = await this.dependencies.conversationService.getConversation(conversationId);

      // Filter conversation for retry: exclude message being retried and everything after
      let filteredConversation = conversation;
      if (conversation && options?.excludeFromMessageId) {
        const excludeIndex = conversation.messages.findIndex((m) => m.id === options.excludeFromMessageId);
        if (excludeIndex >= 0) {
          filteredConversation = {
            ...conversation,
            messages: conversation.messages.slice(0, excludeIndex)
          };
        }
      }

      // Build conversation context for LLM with provider-specific formatting
      // NOTE: buildLLMMessages includes ALL messages from storage, including the user message
      // that was just saved by sendMessage(), so we DON'T add it again here
      const messages = filteredConversation ?
        this.buildLLMMessages(filteredConversation, provider, options?.systemPrompt) : [];

      // Add system prompt if provided and not already added by buildLLMMessages
      if (options?.systemPrompt && !messages.some(m => m.role === 'system')) {
        messages.unshift({ role: 'system', content: options.systemPrompt });
      }

      // Only add user message if it's NOT already in the filtered conversation
      // (happens on first message when conversation is empty, or during retry)
      if (!filteredConversation || !filteredConversation.messages.some((m) => m.content === userMessage && m.role === 'user')) {
        messages.push({ role: 'user', content: userMessage });
      }

      // Get tools from ToolCallService in OpenAI format
      // NOTE: WebLLM/Nexus models are fine-tuned with tool knowledge baked in
      // They don't need tool schemas passed - they generate [TOOL_CALLS] naturally
      const openAITools = shouldPassToolSchemasToProvider(provider)
        ? this.dependencies.toolCallService.getAvailableTools()
        : [];

      // Prepare LLM options with converted tools
      // NOTE: systemPrompt is already in the messages array from buildLLMMessages()
      // Do NOT pass it again here - this caused duplicate system prompts
      const llmOptions: Record<string, unknown> = {
        provider: options?.provider || defaultModel.provider,
        model: options?.model || defaultModel.model,
        // systemPrompt intentionally omitted - already in messages array
        tools: openAITools,
        toolChoice: openAITools.length > 0 ? 'auto' : undefined,
        abortSignal: options?.abortSignal,
        sessionId: options?.sessionId,
        workspaceId: options?.workspaceId,
        conversationId, // CRITICAL: Required for OpenAI Responses API response ID tracking
        messageId,
        turnId: messageId,
        operationOrigin: options?.operationOrigin ?? 'native-chat',
        operationScopeId: options?.operationScopeId,
        enableThinking: options?.enableThinking,
        thinkingEffort: options?.thinkingEffort,
        temperature: options?.temperature,
        imageProvider: options?.imageProvider,
        imageModel: options?.imageModel,
        transcriptionProvider: options?.transcriptionProvider,
        transcriptionModel: options?.transcriptionModel,
        // Responses API (OpenAI/LM Studio): Load persisted ID for conversation continuity
        responsesApiId: filteredConversation?.metadata?.responsesApiId
      };

      // Add tool event callback for live UI updates (delegates to ToolCallService)
      llmOptions.onToolEvent = (event: 'started' | 'completed', data: unknown) => {
        this.dependencies.toolCallService.fireToolEvent(messageId, event, data as Parameters<ToolCallService['fireToolEvent']>[2]);
      };

      // Add usage callback for async cost calculation (e.g., OpenRouter streaming)
      llmOptions.onUsageAvailable = this.dependencies.costTrackingService.createUsageCallback(conversationId, messageId);

      // Responses API: Persist ID when first captured (for conversation continuity across restarts)
      llmOptions.onResponsesApiId = async (id: string) => {
        try {
          const conv = await this.dependencies.conversationService.getConversation(conversationId);
          if (conv) {
            await this.dependencies.conversationService.updateConversation(conversationId, {
              metadata: { ...conv.metadata, responsesApiId: id }
            });
          }
        } catch (err) {
          console.error('[StreamingResponseService] Failed to persist responsesApiId:', err);
        }
      };

      // Stream the response from LLM service with MCP tools
      this.dependencies.toolCallService.resetDetectedTools(); // Reset tool detection state for new message

      // Track usage and cost for conversation tracking
      let finalUsage: NormalizedTokenUsage | undefined = undefined;
      let finalCost: MessageCost | undefined = undefined;
      const selectedModel = typeof llmOptions.model === 'string' ? llmOptions.model : defaultModel.model;
      persistedModel = selectedModel;

      for await (const event of this.dependencies.llmService.generateResponseStream(messages, llmOptions)) {
        // Check if aborted FIRST before processing chunk
        if (options?.abortSignal?.aborted) {
          throw new DOMException('Generation aborted by user', 'AbortError');
        }

        if (event.type === 'usage.updated') {
          const normalizedUsage = ContextBudgetService.normalizeUsage(event.usage);
          if (normalizedUsage) {
            finalUsage = normalizedUsage;
          }
        }

        // Extract tool calls when available and handle progressive display
        if (event.type === 'tool.snapshot') {
          const toolCalls = event.calls;
          const hasMeaningfulArgs = toolCalls.some((tc) => {
            const args = tc.function.arguments;
            return args.trim().length > 0;
          });
          if (hasMeaningfulArgs) {
            this.dependencies.toolCallService.handleToolCallDetection(
              messageId,
              toolCalls,
              event.ready,
              conversationId
            );
          }
        }

        // Cost is a runtime event too, and must precede the terminal event so
        // the reducer can reject every late mutation after terminal state.
        if (event.type === 'turn.completed') {
          if (finalUsage) {
            const usageData = this.dependencies.costTrackingService.extractUsage(finalUsage);
            if (usageData) {
              finalCost = await this.dependencies.costTrackingService.trackMessageUsage(
                conversationId,
                messageId,
                turnState.provider || provider,
                turnState.model || selectedModel,
                usageData
              ) ?? undefined;
            }
          }

          if (finalCost) {
            const costEvent: ChatRuntimeEvent = { type: 'cost.updated', cost: finalCost };
            turnState = reduceChatTurn(turnState, costEvent);
            yield { messageId, event: costEvent };
          }
        }

        turnState = reduceChatTurn(turnState, event);

        // Persist every terminal state before exposing it to consumers. This
        // prevents failed/aborted turns from surviving as draft placeholders.
        if (event.type === 'turn.completed' || event.type === 'turn.aborted' || event.type === 'turn.failed') {
          await this.persistTerminalMessage(
            conversationId,
            messageId,
            turnState,
            provider,
            selectedModel
          );
        }

        yield { messageId, event };

        if (event.type === 'turn.completed' || event.type === 'turn.aborted' || event.type === 'turn.failed') {
          return;
        }
      }

      throw new Error('LLM runtime stream ended without a terminal turn event.');

    } catch (error) {
      const terminalEvent: ChatRuntimeEvent = error instanceof Error && error.name === 'AbortError'
        ? { type: 'turn.aborted', reason: error.message }
        : {
            type: 'turn.failed',
            error: { message: error instanceof Error ? error.message : String(error) },
          };

      if (!turnState.terminalEvent) {
        turnState = reduceChatTurn(turnState, terminalEvent);
      }
      try {
        await this.persistTerminalMessage(
          conversationId,
          messageId,
          turnState,
          persistedProvider,
          persistedModel
        );
      } catch (persistenceError) {
        console.error('[StreamingResponseService] Failed to persist terminal message:', persistenceError);
      }
      yield { messageId, event: terminalEvent };

      const response = error instanceof Error && 'response' in error
        ? (error as Error & { response?: { data?: unknown; json?: unknown; text?: unknown } }).response
        : undefined;
      const extra = response?.data ?? response?.json ?? response?.text;
      console.error('Error in generateResponse:', error, extra ? JSON.stringify(extra) : '');
      throw error;
    } finally {
      // Notify queue service that generation is complete (resumes processing)
      void this.dependencies.messageQueueService?.onGenerationComplete?.();
    }
  }

  private async persistTerminalMessage(
    conversationId: string,
    messageId: string,
    turnState: ChatTurnState,
    provider: string,
    model: string
  ): Promise<void> {
    const conv = await this.dependencies.conversationService.getConversation(conversationId);
    const msg = conv?.messages.find(candidate => candidate.id === messageId);
    if (!conv || !msg) return;

    msg.content = turnState.content;
    msg.state = turnState.phase === 'complete'
      ? 'complete'
      : turnState.phase === 'aborted'
        ? 'aborted'
        : 'invalid';
    msg.isLoading = false;
    msg.toolCalls = turnState.toolCalls.length > 0 ? turnState.toolCalls : undefined;
    const metadata = turnState.error
      ? { ...turnState.metadata, runtimeError: turnState.error }
      : turnState.metadata;
    msg.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
    msg.cost = turnState.cost;
    msg.usage = turnState.usage;
    msg.reasoning = turnState.reasoning.text || undefined;
    msg.provider = turnState.provider || provider;
    msg.model = turnState.model || model;

    await this.dependencies.conversationService.updateConversation(conversationId, {
      messages: conv.messages,
      metadata: conv.metadata
    });
  }

  /**
   * Build message history for LLM context using provider-specific formatting
   *
   * This method uses ConversationContextBuilder to properly reconstruct
   * conversation history with tool calls in the correct format for each provider.
   *
   * NOTE: For Google, we return simple {role, content} format because
   * StreamingOrchestrator will convert to Google format ({role, parts})
   */
  private buildLLMMessages(conversation: ConversationData, provider?: string, systemPrompt?: string): LLMConversationMessage[] {
    const currentProvider = provider || this.getCurrentProvider();

    // Apply compaction boundary: only send messages at or after the boundary to the LLM.
    // The compaction summary is injected via the system prompt (compaction frontier).
    const filteredConversation = this.applyCompactionBoundary(conversation);

    // For Google, return simple format - StreamingOrchestrator handles Google conversion
    if (currentProvider === 'google') {
      const messages: LLMConversationMessage[] = [];

      // Add system prompt if provided
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      // Add conversation messages in simple format
      for (const msg of filteredConversation.messages) {
        if (msg.role === 'user' && msg.content && msg.content.trim()) {
          messages.push({ role: 'user', content: msg.content });
        } else if (msg.role === 'assistant' && msg.content && msg.content.trim()) {
          messages.push({ role: 'assistant', content: msg.content });
        }
      }

      return messages;
    }

    // For other providers, use ConversationContextBuilder.
    // CRITICAL: We must preserve tool_calls (on assistant messages) and
    // tool_call_id (on tool messages). Stripping them caused Azure-via-
    // OpenRouter to reject continuations with "Missing required parameter:
    // 'input[N].call_id'" because tool result messages arrived without
    // the id linking them to the assistant's tool calls.
    //
    // Also preserve reasoning_details / thought_signature / name — latent
    // risks for Gemini-via-OpenRouter (loses chain-of-thought between tool
    // turns), Gemini direct (thought signature echo required), and legacy
    // OpenAI function-role messages. See the canonical-message-pipeline plan.
    return ConversationContextBuilder.buildContextForProvider(
      filteredConversation,
      currentProvider,
      systemPrompt
    ).map((message) => {
      const m = message as {
        role: 'user' | 'assistant' | 'system' | 'tool';
        content?: unknown;
        tool_calls?: unknown;
        tool_call_id?: string;
        reasoning_details?: unknown[];
        thought_signature?: string;
        name?: string;
      };
      const out: LLMConversationMessage = {
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '',
      };
      if (Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls;
      // Use `!== undefined` so an empty-string tool_call_id is preserved.
      // Downstream synthesis sites (e.g. OpenAIContextBuilder, BaseAdapter)
      // own the policy for what to do with an empty id; stripping here
      // causes Azure-via-OpenRouter to reject the continuation with
      // "Missing required parameter: 'input[N].call_id'".
      if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
      if (Array.isArray(m.reasoning_details)) out.reasoning_details = m.reasoning_details;
      if (m.thought_signature) out.thought_signature = m.thought_signature;
      if (m.name) out.name = m.name;
      return out;
    });
  }

  /**
   * Apply compaction boundary filter: return a conversation view with only
   * messages at or after the latest compaction boundary. Messages before
   * the boundary are summarized in the compaction frontier (system prompt).
   */
  private applyCompactionBoundary(conversation: ConversationData): ConversationData {
    const filtered = ContextCompactionService.getMessagesAfterBoundary(
      conversation.messages,
      conversation.metadata
    );

    if (filtered === conversation.messages) {
      return conversation;
    }

    return {
      ...conversation,
      messages: filtered,
    };
  }

  /**
   * Get current provider for context building
   */
  private getCurrentProvider(): string {
    return this.currentProvider || this.dependencies.llmService.getDefaultModel().provider;
  }

  /**
   * Set current provider (for context building)
   */
  setProvider(provider: string): void {
    this.currentProvider = provider;
  }
}
