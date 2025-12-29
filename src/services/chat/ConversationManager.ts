/**
 * ConversationManager - Handles conversation creation and modification
 *
 * Responsibilities:
 * - Create new conversations with optional initial message
 * - Send messages and coordinate AI responses
 * - Add messages to conversations
 * - Update conversation data
 * - Delete conversations
 *
 * Follows Single Responsibility Principle - only handles conversation write operations.
 */

import { ConversationData, CreateConversationParams, ToolCall } from '../../types/chat/ChatTypes';
import { generateSessionId } from '../../utils/sessionUtils';

/** Streaming options for message generation */
interface StreamingOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
  messageId?: string;
  abortSignal?: AbortSignal;
}

/** Streaming chunk result */
interface StreamingChunk {
  chunk: string;
  complete: boolean;
  messageId: string;
  toolCalls?: ToolCall[];
}

/** Conversation service interface */
interface ConversationServiceLike {
  getConversation: (id: string) => Promise<ConversationData | null>;
  addMessage: (params: { conversationId: string; role: string; content: string; id?: string }) => Promise<void>;
  updateConversation: (id: string, updates: Partial<ConversationData>) => Promise<void>;
  createConversation: (data: unknown) => Promise<ConversationData>;
  deleteConversation: (id: string) => Promise<void>;
}

export interface ConversationManagerDependencies {
  conversationService: ConversationServiceLike;
  streamingGenerator: (
    conversationId: string,
    userMessage: string,
    options?: StreamingOptions
  ) => AsyncGenerator<StreamingChunk, void, unknown>;
}

export class ConversationManager {
  constructor(
    private dependencies: ConversationManagerDependencies,
    private vaultName: string
  ) {}

  /**
   * Create a new conversation
   */
  async createConversation(params: CreateConversationParams): Promise<ConversationData> {
    const conversationData = {
      title: params.title,
      vault_name: this.vaultName,
      messages: [],
      metadata: {
        chatSettings: {
          providerId: params.provider,
          modelId: params.model,
          systemPrompt: params.systemPrompt,
          workspaceId: params.workspaceId,
          sessionId: params.sessionId || generateSessionId()
        }
      }
    };

    const conversation = await this.dependencies.conversationService.createConversation(conversationData);

    // Add initial message if provided
    if (params.initialMessage) {
      await this.dependencies.conversationService.addMessage({
        conversationId: conversation.id,
        role: 'user',
        content: params.initialMessage
      });
    }

    return conversation;
  }

  /**
   * Send a message and get AI response
   */
  async* sendMessage(
    conversationId: string,
    message: string,
    options?: StreamingOptions
  ): AsyncGenerator<StreamingChunk, void, unknown> {
    // Save user message first
    await this.dependencies.conversationService.addMessage({
      conversationId,
      role: 'user',
      content: message
    });

    // Generate streaming response
    yield* this.dependencies.streamingGenerator(conversationId, message, options);
  }

  /**
   * Add a message to a conversation
   */
  async addMessage(params: {
    conversationId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    id?: string;
    toolCalls?: ToolCall[];
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.dependencies.conversationService.addMessage(params);
  }

  /**
   * Update conversation metadata
   */
  async updateConversation(conversationId: string, updates: Partial<ConversationData>): Promise<void> {
    await this.dependencies.conversationService.updateConversation(conversationId, updates);
  }

  /**
   * Delete a conversation
   */
  async deleteConversation(id: string): Promise<boolean> {
    try {
      await this.dependencies.conversationService.deleteConversation(id);
      return true;
    } catch (error) {
      console.error('Failed to delete conversation:', error);
      return false;
    }
  }

  /**
   * Update conversation title
   */
  async updateTitle(conversationId: string, title: string): Promise<void> {
    await this.updateConversation(conversationId, { title });
  }

  /**
   * Set conversation workspace
   */
  async setWorkspace(conversationId: string, workspaceId: string): Promise<void> {
    // Get current conversation to preserve existing metadata
    const conversation = await this.dependencies.conversationService.getConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    await this.updateConversation(conversationId, {
      metadata: {
        ...conversation.metadata,
        chatSettings: {
          ...conversation.metadata?.chatSettings,
          workspaceId
        }
      }
    });
  }
}
