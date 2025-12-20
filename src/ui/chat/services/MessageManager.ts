/**
 * MessageManager - Handles all message operations including sending, editing, retry, and streaming
 * Refactored to use extracted services following SOLID principles
 */

import { ChatService } from '../../../services/chat/ChatService';
import { ConversationData, ConversationMessage } from '../../../types/chat/ChatTypes';
import { BranchManager } from './BranchManager';
import { ReferenceMetadata } from '../utils/ReferenceExtractor';
import { MessageAlternativeService } from './MessageAlternativeService';
import { MessageStreamHandler } from './MessageStreamHandler';
import { MessageStateManager } from './MessageStateManager';
import { AbortHandler } from '../utils/AbortHandler';
import { getWebLLMLifecycleManager } from '../../../services/llm/adapters/webllm/WebLLMLifecycleManager';
import type { MessageQueueService } from '../../../services/chat/MessageQueueService';
import type { QueuedMessage } from '../../../types/branch/BranchTypes';

export interface MessageManagerEvents {
  onMessageAdded: (message: ConversationMessage) => void;
  onAIMessageStarted: (message: ConversationMessage) => void;
  onStreamingUpdate: (messageId: string, content: string, isComplete: boolean, isIncremental?: boolean) => void;
  onConversationUpdated: (conversation: ConversationData) => void;
  onLoadingStateChanged: (isLoading: boolean) => void;
  onError: (message: string) => void;
  onToolCallsDetected: (messageId: string, toolCalls: any[]) => void;
  onToolExecutionStarted: (messageId: string, toolCall: { id: string; name: string; parameters?: any }) => void;
  onToolExecutionCompleted: (messageId: string, toolId: string, result: any, success: boolean, error?: string) => void;
  onMessageIdUpdated: (oldId: string, newId: string, updatedMessage: ConversationMessage) => void;
  onGenerationAborted: (messageId: string, partialContent: string) => void;
  // Token usage for context tracking (optional - for local models)
  onUsageAvailable?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
}

export class MessageManager {
  private isLoading = false;
  private currentAbortController: AbortController | null = null;
  private currentStreamingMessageId: string | null = null;

  // Extracted services
  private streamHandler: MessageStreamHandler;
  private abortHandler: AbortHandler;
  private stateManager: MessageStateManager;
  private alternativeService: MessageAlternativeService;

  // Optional queue service for subagent result processing
  private messageQueueService: MessageQueueService | null = null;

  constructor(
    private chatService: ChatService,
    private branchManager: BranchManager,
    private events: MessageManagerEvents
  ) {
    // Initialize extracted services with appropriate event mappings
    this.streamHandler = new MessageStreamHandler(chatService, {
      onStreamingUpdate: events.onStreamingUpdate,
      onToolCallsDetected: events.onToolCallsDetected
    });

    this.abortHandler = new AbortHandler(chatService, {
      onStreamingUpdate: events.onStreamingUpdate,
      onConversationUpdated: events.onConversationUpdated
    });

    this.stateManager = new MessageStateManager(chatService, {
      onMessageAdded: events.onMessageAdded,
      onAIMessageStarted: events.onAIMessageStarted,
      onMessageIdUpdated: events.onMessageIdUpdated,
      onConversationUpdated: events.onConversationUpdated
    });

    this.alternativeService = new MessageAlternativeService(
      chatService,
      branchManager,
      this.streamHandler,
      this.abortHandler,
      {
        onStreamingUpdate: events.onStreamingUpdate,
        onConversationUpdated: events.onConversationUpdated,
        onToolCallsDetected: events.onToolCallsDetected,
        onLoadingStateChanged: (loading) => this.setLoading(loading),
        onError: events.onError
      }
    );
  }

  /**
   * Get current loading state
   */
  getIsLoading(): boolean {
    return this.isLoading;
  }

  /**
   * Set the message queue service for subagent result processing
   * This enables queued delivery of subagent results
   */
  setMessageQueueService(queueService: MessageQueueService): void {
    console.log('[MessageManager] Setting message queue service');
    this.messageQueueService = queueService;

    // Set up the message processor to handle queued messages
    queueService.setProcessor(async (message: QueuedMessage) => {
      console.log('[MessageManager] Processing queued message:', message.type, message.id);

      if (message.type === 'subagent_result') {
        // Subagent completed - notify UI to refresh/display results
        console.log('[MessageManager] Subagent result:', {
          subagentId: message.metadata?.subagentId,
          branchId: message.metadata?.branchId,
          error: message.metadata?.error,
        });

        // The subagent result is already stored in the branch
        // We just need to trigger a UI update
        // This will be handled by ChatView's event system
        this.events.onConversationUpdated?.(null as any); // Force UI refresh
      }
    });
  }

  /**
   * Send a message in a conversation
   */
  async sendMessage(
    conversation: ConversationData,
    message: string,
    options?: {
      provider?: string;
      model?: string;
      systemPrompt?: string;
      workspaceId?: string;
      sessionId?: string;
      enableThinking?: boolean;
      thinkingEffort?: 'low' | 'medium' | 'high';
    },
    metadata?: ReferenceMetadata
  ): Promise<void> {
    let aiMessageId: string | null = null;

    try {
      this.setLoading(true);

      // Record activity for Nexus lifecycle manager (resets idle timer)
      getWebLLMLifecycleManager().recordActivity();

      // Add user message and get real ID from storage
      await this.stateManager.addUserMessage(conversation, message, metadata);

      // Create placeholder AI message
      const placeholderMessage = this.stateManager.createPlaceholderAIMessage(conversation);
      aiMessageId = placeholderMessage.id;

      // Setup abort controller
      this.currentAbortController = new AbortController();
      this.currentStreamingMessageId = aiMessageId;

      // Stream AI response
      const streamResult = await this.streamHandler.streamAndSave(
        conversation,
        message,
        aiMessageId,
        {
          ...options,
          abortSignal: this.currentAbortController.signal
        }
      );

      // Report usage for context tracking (e.g., for local models with limited context)
      if (streamResult.usage && this.events.onUsageAvailable) {
        this.events.onUsageAvailable(streamResult.usage);
      }

      // Reload conversation from storage to sync
      await this.stateManager.reloadConversation(conversation);

      // Notify that conversation has been updated
      this.events.onConversationUpdated(conversation);

    } catch (error) {
      // Handle abort scenario
      const wasAborted = await this.abortHandler.handleIfAbortError(
        error,
        conversation,
        aiMessageId
      );

      if (!wasAborted) {
        this.events.onError('Failed to send message');
      }
    } finally {
      this.currentAbortController = null;
      this.setLoading(false);
    }
  }

  /**
   * Handle retry message action - creates message-level alternatives
   */
  async handleRetryMessage(
    conversation: ConversationData,
    messageId: string,
    options?: {
      provider?: string;
      model?: string;
      systemPrompt?: string;
      workspaceId?: string;
      sessionId?: string;
      enableThinking?: boolean;
      thinkingEffort?: 'low' | 'medium' | 'high';
    }
  ): Promise<void> {
    const message = conversation.messages.find(msg => msg.id === messageId);
    if (!message) return;

    try {
      // For user messages, regenerate the AI response
      if (message.role === 'user') {
        await this.regenerateAIResponse(conversation, messageId, options);
      }
      // For AI messages, create an alternative response
      else if (message.role === 'assistant') {
        await this.alternativeService.createAlternativeResponse(conversation, messageId, options);
      }

      // Notify that conversation was updated
      this.events.onConversationUpdated(conversation);

    } catch (error) {
      this.events.onError('Failed to retry message');
    }
  }

  /**
   * Regenerate AI response for a user message
   */
  private async regenerateAIResponse(
    conversation: ConversationData,
    userMessageId: string,
    options?: {
      provider?: string;
      model?: string;
      systemPrompt?: string;
      workspaceId?: string;
      sessionId?: string;
    }
  ): Promise<void> {
    const userMessage = conversation.messages.find(msg => msg.id === userMessageId);
    if (!userMessage || userMessage.role !== 'user') return;

    // Find the AI message that follows this user message
    const userMessageIndex = conversation.messages.findIndex(msg => msg.id === userMessageId);
    if (userMessageIndex === -1) return;

    const aiMessageIndex = userMessageIndex + 1;
    const aiMessage = conversation.messages[aiMessageIndex];

    if (aiMessage && aiMessage.role === 'assistant') {
      // Create alternative for existing AI message
      await this.alternativeService.createAlternativeResponse(conversation, aiMessage.id, options);
    } else {
      // No AI response exists - generate a fresh one
      await this.generateFreshAIResponse(conversation, userMessage, options);
    }
  }

  /**
   * Generate a fresh AI response when no response exists
   */
  private async generateFreshAIResponse(
    conversation: ConversationData,
    userMessage: ConversationMessage,
    options?: {
      provider?: string;
      model?: string;
      systemPrompt?: string;
      workspaceId?: string;
      sessionId?: string;
    }
  ): Promise<void> {
    try {
      this.setLoading(true);

      // Create new AI message placeholder
      const placeholderMessage = this.stateManager.createPlaceholderAIMessage(conversation);
      const aiMessageId = placeholderMessage.id;

      // Setup abort controller
      this.currentAbortController = new AbortController();
      this.currentStreamingMessageId = aiMessageId;

      // Stream the AI response
      const streamResult = await this.streamHandler.streamAndSave(
        conversation,
        userMessage.content,
        aiMessageId,
        {
          ...options,
          abortSignal: this.currentAbortController.signal
        }
      );

      // Report usage for context tracking
      if (streamResult.usage && this.events.onUsageAvailable) {
        this.events.onUsageAvailable(streamResult.usage);
      }

      // Reload conversation from storage
      await this.stateManager.reloadConversation(conversation);

      // Notify that conversation has been updated
      this.events.onConversationUpdated(conversation);

    } catch (error) {
      // Handle abort scenario
      const wasAborted = await this.abortHandler.handleIfAbortError(
        error,
        conversation,
        this.currentStreamingMessageId
      );

      if (!wasAborted) {
        this.events.onError('Failed to generate AI response');
      }
    } finally {
      this.currentAbortController = null;
      this.currentStreamingMessageId = null;
      this.setLoading(false);
    }
  }

  /**
   * Handle edit message action - ONLY updates content, does NOT regenerate
   */
  async handleEditMessage(
    conversation: ConversationData,
    messageId: string,
    newContent: string,
    options?: {
      provider?: string;
      model?: string;
      systemPrompt?: string;
      workspaceId?: string;
      sessionId?: string;
    }
  ): Promise<void> {
    await this.stateManager.updateMessageContent(conversation, messageId, newContent);
  }

  /**
   * Add a user message for optimistic updates
   */
  addUserMessage(conversation: ConversationData, content: string): void {
    const message: ConversationMessage = {
      id: `temp_${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
      conversationId: conversation.id
    };

    conversation.messages.push(message);
    this.events.onMessageAdded(message);
  }

  /**
   * Cancel current generation (abort streaming)
   * Always resets loading state even if no active abort controller
   */
  cancelCurrentGeneration(): void {
    const messageId = this.currentStreamingMessageId;

    // Abort the stream if active
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }

    // Always reset streaming message ID
    this.currentStreamingMessageId = null;

    // Always reset loading state (prevents stuck state)
    this.setLoading(false);

    // Fire abort event if we had an active message
    if (messageId) {
      this.events.onGenerationAborted(messageId, '');
    }
  }

  /**
   * Set loading state and notify
   */
  private setLoading(loading: boolean): void {
    this.isLoading = loading;
    this.events.onLoadingStateChanged(loading);
  }
}
