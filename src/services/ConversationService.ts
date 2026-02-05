// Location: src/services/ConversationService.ts
// Conversation management service with hybrid storage support
// Used by: ChatService, ConversationManager, UI components
// Dependencies: FileSystemService + IndexManager (legacy) OR IStorageAdapter (new)
//
// MIGRATION NOTE: This service supports both storage backends:
// - Legacy: FileSystemService + IndexManager (JSON files + index)
// - New: IStorageAdapter (JSONL + SQLite hybrid storage)
// The adapter is prioritized if available, otherwise falls back to legacy.

import { Plugin } from 'obsidian';
import { FileSystemService } from './storage/FileSystemService';
import { IndexManager } from './storage/IndexManager';
import { IndividualConversation, ConversationMetadata as LegacyConversationMetadata, ConversationMessage } from '../types/storage/StorageTypes';

// Re-export for consumers
export type { IndividualConversation, ConversationMessage } from '../types/storage/StorageTypes';
import { IStorageAdapter } from '../database/interfaces/IStorageAdapter';
import { ConversationMetadata, MessageData } from '../types/storage/HybridStorageTypes';
import { PaginationParams, PaginatedResult, calculatePaginationMetadata } from '../types/pagination/PaginationTypes';
import type { ConversationBranch, SubagentBranchMetadata, HumanBranchMetadata } from '../types/branch/BranchTypes';

/**
 * Type for the storage adapter parameter: either a direct adapter instance
 * or a getter function that lazily resolves the adapter.
 * The getter pattern ensures services pick up the adapter after SQLite
 * finishes initializing in the background, rather than capturing a
 * one-time null reference at construction time.
 */
type StorageAdapterOrGetter = IStorageAdapter | (() => IStorageAdapter | undefined) | undefined;

export class ConversationService {
  private storageAdapterOrGetter: StorageAdapterOrGetter;

  constructor(
    private plugin: Plugin,
    private fileSystem: FileSystemService,
    private indexManager: IndexManager,
    storageAdapter?: StorageAdapterOrGetter
  ) {
    this.storageAdapterOrGetter = storageAdapter;
  }

  /**
   * Resolve the storage adapter, supporting both direct references and getter functions.
   * Returns the adapter only if it is ready (SQLite initialized). Falls back to undefined
   * so callers use JSONL-only storage.
   */
  private getReadyAdapter(): IStorageAdapter | undefined {
    let adapter: IStorageAdapter | undefined;

    if (typeof this.storageAdapterOrGetter === 'function') {
      adapter = this.storageAdapterOrGetter();
    } else {
      adapter = this.storageAdapterOrGetter;
    }

    if (adapter && adapter.isReady()) {
      return adapter;
    }

    return undefined;
  }

  /**
   * List conversations (uses index only - lightweight and fast)
   */
  async listConversations(vaultName?: string, limit?: number): Promise<LegacyConversationMetadata[]> {
    // Use adapter if available and ready (avoids blocking on SQLite initialization)
    const adapterForList = this.getReadyAdapter();
    if (adapterForList) {
      const result = await adapterForList.getConversations({
        filter: vaultName ? { vaultName } : undefined,
        pageSize: limit ?? 100,
        page: 0,
        sortBy: 'updated',
        sortOrder: 'desc'
      });
      // Convert new format to legacy format
      return result.items.map(this.convertToLegacyMetadata);
    }

    // Fall back to legacy storage
    const index = await this.indexManager.loadConversationIndex();
    let conversations = Object.values(index.conversations);

    // Filter by vault if specified
    if (vaultName) {
      conversations = conversations.filter(conv => conv.vault_name === vaultName);
    }

    // Sort by updated timestamp (most recent first)
    conversations.sort((a, b) => b.updated - a.updated);

    // Apply limit if specified
    if (limit) {
      conversations = conversations.slice(0, limit);
    }

    return conversations;
  }

  /**
   * Get full conversation with messages (loads individual file or queries from adapter)
   *
   * KEY IMPROVEMENT: With adapter, messages are paginated from SQLite instead of loading all
   *
   * @param id - Conversation ID
   * @param paginationOptions - Optional pagination parameters for message loading
   * @returns Conversation with paginated messages (or all messages if no pagination specified)
   */
  async getConversation(
    id: string,
    paginationOptions?: PaginationParams
  ): Promise<IndividualConversation | null> {
    // Use adapter if available and ready (avoids blocking on SQLite initialization)
    const adapterForGet = this.getReadyAdapter();
    if (adapterForGet) {
      const metadata = await adapterForGet.getConversation(id);
      if (!metadata) {
        return null;
      }

      // Apply pagination or load all messages (default: first 1000 for backward compatibility)
      const messagesResult = await adapterForGet.getMessages(id, {
        page: paginationOptions?.page ?? 0,
        pageSize: paginationOptions?.pageSize ?? 1000
      });

      // Convert to legacy format
      const conversation = this.convertToLegacyConversation(metadata, messagesResult.items);

      // Populate message.branches from branch storage (unified model)
      // Branch conversations have parentConversationId and parentMessageId in metadata
      await this.populateMessageBranches(id, conversation.messages);

      // Attach pagination metadata if pagination was requested
      if (paginationOptions) {
        // Convert MessageData pagination to ConversationMessage pagination
        conversation.messagePagination = {
          ...messagesResult,
          items: conversation.messages // Already converted by convertToLegacyConversation
        };
      }

      return conversation;
    }

    // Fall back to legacy storage
    const conversation = await this.fileSystem.readConversation(id);

    if (!conversation) {
      return null;
    }

    // Migration: Add state field to messages that don't have it
    if (conversation.messages && conversation.messages.length > 0) {
      conversation.messages = conversation.messages.map(msg => {
        if (!msg.state) {
          // Default existing messages to 'complete' state
          // They were saved, so they must be complete
          msg.state = 'complete';
        }
        return msg;
      });
    }

    // Note: Old alternatives[] migration removed - unified branch model uses
    // separate conversations with parent metadata, not embedded branches

    // If pagination was requested for legacy storage, slice the messages array
    if (paginationOptions) {
      const page = paginationOptions.page ?? 0;
      const pageSize = paginationOptions.pageSize ?? 50;
      const totalMessages = conversation.messages.length;
      const startIndex = page * pageSize;
      const endIndex = startIndex + pageSize;

      const paginatedMessages = conversation.messages.slice(startIndex, endIndex);
      const paginationMetadata = calculatePaginationMetadata(page, pageSize, totalMessages);

      // Store original messages count but return paginated subset
      conversation.messagePagination = {
        ...paginationMetadata,
        items: paginatedMessages
      };
      conversation.messages = paginatedMessages;
    }

    return conversation;
  }

  /**
   * Get messages for a conversation (paginated)
   *
   * This method allows fetching messages without loading the full conversation metadata.
   * Useful for lazy loading messages in UI components.
   *
   * @param conversationId - Conversation ID
   * @param options - Pagination parameters
   * @returns Paginated result containing messages
   */
  async getMessages(
    conversationId: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<any>> {
    // Use adapter if available and ready (avoids blocking on SQLite initialization)
    const adapterForMsgs = this.getReadyAdapter();
    if (adapterForMsgs) {
      const messagesResult = await adapterForMsgs.getMessages(conversationId, {
        page: options?.page ?? 0,
        pageSize: options?.pageSize ?? 50
      });

      // Convert MessageData to legacy message format
      return {
        ...messagesResult,
        items: messagesResult.items.map(msg => ({
          id: msg.id,
          role: msg.role as 'user' | 'assistant' | 'tool',
          content: msg.content || '',
          timestamp: msg.timestamp,
          state: msg.state,
          toolCalls: msg.toolCalls?.map(tc => {
            // Handle both formats:
            // 1. Standard OpenAI format: { function: { name, arguments } }
            // 2. Result format from buildToolMetadata: { name, result, success, error }
            const hasFunction = tc.function && typeof tc.function === 'object';
            const name = (hasFunction ? tc.function.name : tc.name) || 'unknown_tool';
            const parameters = hasFunction && tc.function.arguments
              ? (typeof tc.function.arguments === 'string'
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments)
              : tc.parameters;
            return {
              id: tc.id,
              type: tc.type || 'function',
              name,
              function: tc.function || { name, arguments: JSON.stringify(parameters || {}) },
              parameters: parameters || {},
              result: tc.result,
              success: tc.success,
              error: tc.error
            };
          }),
          reasoning: msg.reasoning,
          metadata: msg.metadata,
          // Branching support
          alternatives: msg.alternatives,
          activeAlternativeIndex: msg.activeAlternativeIndex
        }))
      };
    }

    // Fall back to legacy storage - load full conversation and slice messages
    const conversation = await this.fileSystem.readConversation(conversationId);
    if (!conversation) {
      return {
        items: [],
        page: 0,
        pageSize: options?.pageSize ?? 50,
        totalItems: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false
      };
    }

    const page = options?.page ?? 0;
    const pageSize = options?.pageSize ?? 50;
    const totalMessages = conversation.messages.length;
    const startIndex = page * pageSize;
    const endIndex = startIndex + pageSize;

    const paginatedMessages = conversation.messages.slice(startIndex, endIndex);
    const paginationMetadata = calculatePaginationMetadata(page, pageSize, totalMessages);

    return {
      ...paginationMetadata,
      items: paginatedMessages
    };
  }

  /**
   * Get all conversations with full data (expensive - avoid if possible)
   */
  async getAllConversations(): Promise<IndividualConversation[]> {
    const conversationIds = await this.fileSystem.listConversationIds();
    const conversations: IndividualConversation[] = [];

    for (const id of conversationIds) {
      const conversation = await this.fileSystem.readConversation(id);
      if (conversation) {
        conversations.push(conversation);
      }
    }

    return conversations;
  }

  /**
   * Create new conversation (writes to adapter or legacy storage)
   */
  async createConversation(data: Partial<IndividualConversation>): Promise<IndividualConversation> {
    const id = data.id || `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Use adapter if available and ready (avoids blocking on SQLite initialization)
    const adapterForCreate = this.getReadyAdapter();
    if (adapterForCreate) {
      const conversationId = await adapterForCreate.createConversation({
        title: data.title || 'Untitled Conversation',
        created: data.created ?? Date.now(),
        updated: data.updated ?? Date.now(),
        vaultName: data.vault_name || this.plugin.app.vault.getName(),
        workspaceId: data.metadata?.chatSettings?.workspaceId,
        sessionId: data.metadata?.chatSettings?.sessionId,
        metadata: data.metadata  // Pass full metadata for branch support (parentConversationId, branchType, etc.)
      });

      // Get created conversation
      const metadata = await adapterForCreate.getConversation(conversationId);
      if (!metadata) {
        throw new Error('Failed to retrieve created conversation');
      }

      // Convert to legacy format
      return this.convertToLegacyConversation(metadata, []);
    }

    // Fall back to legacy storage
    const conversation: IndividualConversation = {
      id,
      title: data.title || 'Untitled Conversation',
      created: data.created || Date.now(),
      updated: data.updated || Date.now(),
      vault_name: data.vault_name || this.plugin.app.vault.getName(),
      message_count: data.messages?.length || 0,
      messages: data.messages || [],
      metadata: data.metadata // ⚠️ CRITICAL: Preserve metadata including sessionId!
    };

    // Write conversation file
    await this.fileSystem.writeConversation(id, conversation);

    // Update index
    await this.indexManager.updateConversationInIndex(conversation);

    return conversation;
  }

  /**
   * Update conversation (updates adapter or legacy storage)
   */
  async updateConversation(id: string, updates: Partial<IndividualConversation>): Promise<void> {
    // Use adapter if available and ready (avoids blocking on SQLite initialization)
    const adapterForUpdate = this.getReadyAdapter();
    if (adapterForUpdate) {
      // Merge existing metadata so we don't lose chat settings when only cost is updated
      const existing = await adapterForUpdate.getConversation(id);
      // Type assertion for metadata structure
      type ChatSettingsType = NonNullable<IndividualConversation['metadata']>['chatSettings'];
      const existingMetadata = (existing?.metadata ?? {}) as IndividualConversation['metadata'];
      const existingChatSettings = (existingMetadata?.chatSettings ?? {}) as ChatSettingsType;
      const updatesChatSettings = (updates.metadata?.chatSettings ?? {}) as ChatSettingsType;

      // IMPORTANT: Preserve ALL existing metadata fields (parentConversationId, parentMessageId, branchType, etc.)
      // Then apply updates on top, with special handling for nested chatSettings
      const mergedMetadata = {
        ...existingMetadata,
        ...updates.metadata,
        chatSettings: {
          ...existingChatSettings,
          ...updatesChatSettings,
          workspaceId: updatesChatSettings?.workspaceId ?? existingChatSettings?.workspaceId,
          sessionId: updatesChatSettings?.sessionId ?? existingChatSettings?.sessionId
        },
        cost: updates.cost || updates.metadata?.cost || existingMetadata?.cost
      };

      // If messages are provided, persist message-level updates through the adapter
      if (updates.messages && updates.messages.length > 0) {
        // Update each message's persisted content/state/reasoning
        for (const msg of updates.messages) {
          const convertedToolCalls = msg.toolCalls?.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: tc.function || {
              name: tc.name || 'unknown_tool',
              arguments: JSON.stringify(tc.parameters || {})
            },
            result: tc.result,
            success: tc.success,
            error: tc.error,
            executionTime: tc.executionTime
          }));

          await adapterForUpdate.updateMessage(id, msg.id, {
            content: msg.content ?? null,
            state: msg.state,
            reasoning: msg.reasoning,
            toolCalls: convertedToolCalls,
            toolCallId: msg.toolCallId,
            // Branching support - cast needed due to type differences between storage layers
            alternatives: msg.alternatives as unknown as import('../types/storage/HybridStorageTypes').AlternativeMessage[] | undefined,
            activeAlternativeIndex: msg.activeAlternativeIndex
          });
        }

        // Also bump the conversation's updated timestamp to keep listings fresh
        await adapterForUpdate.updateConversation(id, {
          title: updates.title,
          updated: updates.updated ?? Date.now(),
          workspaceId: updates.metadata?.chatSettings?.workspaceId,
          sessionId: updates.metadata?.chatSettings?.sessionId,
          metadata: mergedMetadata
        });
      } else {
        // Metadata-only update
        await adapterForUpdate.updateConversation(id, {
          title: updates.title,
          updated: updates.updated ?? Date.now(),
          workspaceId: updates.metadata?.chatSettings?.workspaceId,
          sessionId: updates.metadata?.chatSettings?.sessionId,
          metadata: mergedMetadata
        });
      }
      return;
    }

    // Fall back to legacy storage
    // Load existing conversation
    const conversation = await this.fileSystem.readConversation(id);

    if (!conversation) {
      throw new Error(`Conversation ${id} not found`);
    }

    // Apply updates
    const updatedConversation: IndividualConversation = {
      ...conversation,
      ...updates,
      id, // Preserve ID
      updated: Date.now(),
      message_count: updates.messages?.length ?? conversation.message_count
    };

    // Write updated conversation
    await this.fileSystem.writeConversation(id, updatedConversation);

    // Update index
    await this.indexManager.updateConversationInIndex(updatedConversation);
  }

  /**
   * Delete conversation (deletes from adapter or legacy storage)
   */
  async deleteConversation(id: string): Promise<void> {
    // Use adapter if available and ready (avoids blocking on SQLite initialization)
    const adapterForDelete = this.getReadyAdapter();
    if (adapterForDelete) {
      await adapterForDelete.deleteConversation(id);
      return;
    }

    // Fall back to legacy storage
    // Delete conversation file
    await this.fileSystem.deleteConversation(id);

    // Remove from index
    await this.indexManager.removeConversationFromIndex(id);
  }

  /**
   * Update conversation metadata only (for chat settings persistence)
   */
  async updateConversationMetadata(id: string, metadata: any): Promise<void> {
    await this.updateConversation(id, { metadata });
  }

  /**
   * Add message to conversation
   *
   * KEY IMPROVEMENT: With adapter, messages are streamed via addMessage() instead of rewriting entire file
   */
  async addMessage(params: {
    conversationId: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: any[];
    cost?: { totalCost: number; currency: string };
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    provider?: string;
    model?: string;
    id?: string; // Optional: specify messageId for placeholder messages
    metadata?: any;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      // Use adapter if available and ready (avoids blocking on SQLite initialization)
      const adapterForAddMsg = this.getReadyAdapter();
      if (adapterForAddMsg) {
        // Determine initial state based on role and content
        let initialState: 'draft' | 'complete' = 'complete';
        if (params.role === 'assistant' && (!params.content || params.content.trim() === '')) {
          // Empty assistant messages are placeholders for streaming
          initialState = 'draft';
        }

        const messageId = await adapterForAddMsg.addMessage(params.conversationId, {
          id: params.id,
          role: params.role,
          content: params.content,
          timestamp: Date.now(),
          state: initialState,
          toolCalls: params.toolCalls,
          metadata: params.metadata
        });

        return {
          success: true,
          messageId
        };
      }

      // Fall back to legacy storage
      // Load conversation
      const conversation = await this.fileSystem.readConversation(params.conversationId);

      if (!conversation) {
        return {
          success: false,
          error: `Conversation ${params.conversationId} not found`
        };
      }

      // Create message (use provided ID if available, otherwise generate new one)
      const messageId = params.id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Determine initial state based on role and content
      let initialState: 'draft' | 'complete' = 'complete';
      if (params.role === 'assistant' && (!params.content || params.content.trim() === '')) {
        // Empty assistant messages are placeholders for streaming
        initialState = 'draft';
      }

      const message = {
        id: messageId,
        role: params.role,
        content: params.content,
        timestamp: Date.now(),
        state: initialState,
        toolCalls: params.toolCalls || undefined,
        cost: params.cost,
        usage: params.usage,
        provider: params.provider,
        model: params.model,
        metadata: params.metadata
      };

      // Append message
      conversation.messages.push(message);
      conversation.message_count = conversation.messages.length;
      conversation.updated = Date.now();

      // Update conversation-level cost summary
      if (params.cost) {
        conversation.metadata = conversation.metadata || {};
        conversation.metadata.totalCost = (conversation.metadata.totalCost || 0) + params.cost.totalCost;
        conversation.metadata.currency = params.cost.currency;
      }

      if (params.usage) {
        conversation.metadata = conversation.metadata || {};
        conversation.metadata.totalTokens = (conversation.metadata.totalTokens || 0) + params.usage.totalTokens;
      }

      // Save conversation
      await this.fileSystem.writeConversation(params.conversationId, conversation);

      // Update index metadata
      await this.indexManager.updateConversationInIndex(conversation);

      return {
        success: true,
        messageId
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Update an existing message in a conversation
   * Used for streaming updates, state changes, and adding tool results
   */
  async updateMessage(
    conversationId: string,
    messageId: string,
    updates: {
      content?: string;
      state?: 'draft' | 'streaming' | 'complete' | 'aborted' | 'invalid';
      toolCalls?: any[];
      reasoning?: string;
    }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Use adapter if available and ready (avoids blocking on SQLite initialization)
      const adapterForUpdateMsg = this.getReadyAdapter();
      if (adapterForUpdateMsg) {
        await adapterForUpdateMsg.updateMessage(conversationId, messageId, updates);
        return { success: true };
      }

      // Fall back to legacy storage
      const conversation = await this.fileSystem.readConversation(conversationId);
      if (!conversation) {
        return { success: false, error: `Conversation ${conversationId} not found` };
      }

      const messageIndex = conversation.messages.findIndex(m => m.id === messageId);
      if (messageIndex === -1) {
        return { success: false, error: `Message ${messageId} not found` };
      }

      // Apply updates
      const message = conversation.messages[messageIndex];
      if (updates.content !== undefined) message.content = updates.content;
      if (updates.state !== undefined) message.state = updates.state;
      if (updates.toolCalls !== undefined) message.toolCalls = updates.toolCalls;
      if (updates.reasoning !== undefined) message.reasoning = updates.reasoning;

      conversation.updated = Date.now();

      await this.fileSystem.writeConversation(conversationId, conversation);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Search conversations (uses adapter FTS or legacy index)
   */
  async searchConversations(query: string, limit?: number): Promise<LegacyConversationMetadata[]> {
    if (!query) {
      return this.listConversations(undefined, limit);
    }

    // Use adapter if available and ready (avoids blocking on SQLite initialization)
    const adapterForSearch = this.getReadyAdapter();
    if (adapterForSearch) {
      const results = await adapterForSearch.searchConversations(query);
      // Convert and apply limit
      const converted = results.map(this.convertToLegacyMetadata);
      return limit ? converted.slice(0, limit) : converted;
    }

    // Fall back to legacy storage
    const index = await this.indexManager.loadConversationIndex();
    const words = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
    const matchedIds = new Set<string>();

    // Search title and content indices
    for (const word of words) {
      // Search titles
      if (index.byTitle[word]) {
        index.byTitle[word].forEach(id => matchedIds.add(id));
      }

      // Search content
      if (index.byContent[word]) {
        index.byContent[word].forEach(id => matchedIds.add(id));
      }
    }

    // Get metadata for matched conversations
    const results = Array.from(matchedIds)
      .map(id => index.conversations[id])
      .filter(conv => conv !== undefined)
      .sort((a, b) => b.updated - a.updated);

    // Apply limit
    const limited = limit ? results.slice(0, limit) : results;

    return limited;
  }

  /**
   * Get conversations by vault (uses index)
   */
  async getConversationsByVault(vaultName: string): Promise<LegacyConversationMetadata[]> {
    return this.listConversations(vaultName);
  }

  /**
   * Search conversations by date range (uses index)
   */
  async searchConversationsByDateRange(startDate: number, endDate: number): Promise<LegacyConversationMetadata[]> {
    const index = await this.indexManager.loadConversationIndex();
    const matchedIds = new Set<string>();

    // Check each date range bucket
    for (const bucket of index.byDateRange) {
      // If bucket overlaps with search range, add its conversations
      if (bucket.start <= endDate && bucket.end >= startDate) {
        bucket.conversationIds.forEach(id => matchedIds.add(id));
      }
    }

    // Get metadata and filter by exact date range
    const results = Array.from(matchedIds)
      .map(id => index.conversations[id])
      .filter(conv => conv && conv.created >= startDate && conv.created <= endDate)
      .sort((a, b) => b.created - a.created);

    return results;
  }

  /**
   * Get recent conversations (uses index)
   */
  async getRecentConversations(limit: number = 10): Promise<LegacyConversationMetadata[]> {
    return this.listConversations(undefined, limit);
  }

  /**
   * Get conversation stats (uses index)
   */
  async getConversationStats(): Promise<{
    totalConversations: number;
    totalMessages: number;
    vaultCounts: Record<string, number>;
    oldestConversation?: number;
    newestConversation?: number;
  }> {
    const index = await this.indexManager.loadConversationIndex();
    const conversations = Object.values(index.conversations);

    const stats = {
      totalConversations: conversations.length,
      totalMessages: 0,
      vaultCounts: {} as Record<string, number>,
      oldestConversation: undefined as number | undefined,
      newestConversation: undefined as number | undefined
    };

    if (conversations.length === 0) {
      return stats;
    }

    let oldest = Infinity;
    let newest = 0;

    for (const conv of conversations) {
      stats.totalMessages += conv.message_count || 0;

      // Count by vault
      const vault = conv.vault_name || 'Unknown';
      stats.vaultCounts[vault] = (stats.vaultCounts[vault] || 0) + 1;

      // Track date range
      if (conv.created < oldest) oldest = conv.created;
      if (conv.created > newest) newest = conv.created;
    }

    stats.oldestConversation = oldest === Infinity ? undefined : oldest;
    stats.newestConversation = newest === 0 ? undefined : newest;

    return stats;
  }

  // ============================================================================
  // Type Conversion Helpers (New Format <-> Legacy Format)
  // ============================================================================

  /**
   * Convert new ConversationMetadata to legacy format
   */
  private convertToLegacyMetadata = (metadata: ConversationMetadata): LegacyConversationMetadata => {
    return {
      id: metadata.id,
      title: metadata.title,
      created: metadata.created,
      updated: metadata.updated,
      vault_name: metadata.vaultName,
      message_count: metadata.messageCount
    };
  };

  /**
   * Populate message.branches from unified branch storage
   *
   * With unified model, branches are separate conversations with parentConversationId
   * and parentMessageId in metadata. This method queries those and converts them
   * to the embedded ConversationBranch format for UI compatibility.
   *
   * Required for MessageBranchNavigator to show branch navigation on messages.
   * Works for both human branches and subagent branches.
   */
  private async populateMessageBranches(
    conversationId: string,
    messages: ConversationMessage[]
  ): Promise<void> {
    // Get all branch conversations for this parent
    const allBranchConversations = await this.getBranchConversations(conversationId);

    if (allBranchConversations.length === 0) {
      return;
    }

    // Group branches by parent message ID
    const branchesByMessage = new Map<string, IndividualConversation[]>();
    for (const branch of allBranchConversations) {
      const parentMessageId = branch.metadata?.parentMessageId;
      if (parentMessageId) {
        const existing = branchesByMessage.get(parentMessageId) || [];
        existing.push(branch);
        branchesByMessage.set(parentMessageId, existing);
      }
    }

    // Attach branches to their parent messages
    for (const message of messages) {
      const branchConversations = branchesByMessage.get(message.id);

      if (branchConversations && branchConversations.length > 0) {
        // Convert each branch conversation to embedded ConversationBranch format
        const branches: ConversationBranch[] = branchConversations.map(bc =>
          this.convertToConversationBranch(bc)
        );

        message.branches = branches;
        // Initialize activeAlternativeIndex if not set (0 = original message)
        if (message.activeAlternativeIndex === undefined) {
          message.activeAlternativeIndex = 0;
        }
      }
    }
  }

  /**
   * Convert a branch conversation to embedded ConversationBranch format
   * Used for UI compatibility with message.branches[]
   */
  private convertToConversationBranch(branchConversation: IndividualConversation): ConversationBranch {
    const meta = branchConversation.metadata || {};
    const branchType = meta.branchType === 'subagent' ? 'subagent' : 'human';

    // Extract subagent-specific metadata if present
    const subagentMeta = meta.subagent as SubagentBranchMetadata | undefined;

    return {
      id: branchConversation.id,
      type: branchType,
      inheritContext: meta.inheritContext ?? (branchType === 'human'),
      messages: branchConversation.messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        conversationId: branchConversation.id,
        state: m.state,
        toolCalls: m.toolCalls as any, // Type compatibility between storage and chat types
        reasoning: m.reasoning,
      })),
      created: branchConversation.created,
      updated: branchConversation.updated,
      metadata: branchType === 'subagent' && subagentMeta
        ? subagentMeta
        : { description: branchConversation.title } as HumanBranchMetadata,
    };
  }

  /**
   * Convert new ConversationMetadata + MessageData[] to legacy IndividualConversation
   */
  private convertToLegacyConversation(
    metadata: ConversationMetadata,
    messages: MessageData[]
  ): IndividualConversation {
    // Type assertion for metadata - structure matches IndividualConversation.metadata
    const meta = (metadata.metadata || {}) as IndividualConversation['metadata'] & Record<string, unknown>;
    const metaCost = meta?.cost;
    const metaTotalCost = meta?.totalCost;
    const metaCurrency = meta?.currency;
    const resolvedCost = metaCost || (metaTotalCost !== undefined ? { totalCost: metaTotalCost, currency: metaCurrency || 'USD' } : undefined);
    return {
      id: metadata.id,
      title: metadata.title,
      created: metadata.created,
      updated: metadata.updated,
      vault_name: metadata.vaultName,
      message_count: metadata.messageCount,
      messages: messages.map(msg => ({
        id: msg.id,
        role: msg.role as 'user' | 'assistant' | 'tool',
        content: msg.content || '',
        timestamp: msg.timestamp,
        state: msg.state,
        toolCalls: msg.toolCalls?.map(tc => {
          // Handle both formats:
          // 1. Standard OpenAI format: { function: { name, arguments } }
          // 2. Result format from buildToolMetadata: { name, result, success, error }
          const hasFunction = tc.function && typeof tc.function === 'object';
          const name = (hasFunction ? tc.function.name : tc.name) || 'unknown_tool';
          const parameters = hasFunction && tc.function.arguments
            ? (typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments)
            : tc.parameters;
          return {
            id: tc.id,
            type: tc.type || 'function',
            name,
            function: tc.function || { name, arguments: JSON.stringify(parameters || {}) },
            parameters: parameters || {},
            result: tc.result,
            success: tc.success,
            error: tc.error
          };
        }),
        reasoning: msg.reasoning,
        metadata: msg.metadata,
        // Branching support - cast needed due to AlternativeMessage vs ConversationMessage type differences
        alternatives: msg.alternatives as unknown as import('../types/storage/StorageTypes').ConversationMessage[] | undefined,
        activeAlternativeIndex: msg.activeAlternativeIndex
      })),
      // Preserve ALL metadata from storage (parentConversationId, branchType, subagent, etc.)
      // while ensuring chatSettings structure is maintained for compatibility
      metadata: {
        ...meta,  // Spread stored metadata first (parentConversationId, branchType, subagent, etc.)
        chatSettings: {
          ...meta.chatSettings,
          workspaceId: metadata.workspaceId,
          sessionId: metadata.sessionId
        },
        cost: resolvedCost
      },
      cost: resolvedCost
    };
  }

  // ========================================
  // Branch Query Methods (Phase 1.2)
  // Branches are conversations with parentConversationId metadata
  // ========================================

  /**
   * Get all branch conversations for a parent conversation
   * @param parentConversationId - The parent conversation ID
   * @returns Array of branch conversations
   */
  async getBranchConversations(parentConversationId: string): Promise<IndividualConversation[]> {
    // Use adapter if available and ready (avoids blocking on SQLite initialization)
    const adapterForBranches = this.getReadyAdapter();
    if (adapterForBranches) {
      // Query for conversations with this parent (must include branches!)
      const result = await adapterForBranches.getConversations({
        pageSize: 100,
        page: 0,
        sortBy: 'created',
        sortOrder: 'asc',
        includeBranches: true  // Required - we're specifically looking for branches
      });

      // Filter by parent metadata
      const branches: IndividualConversation[] = [];
      for (const item of result.items) {
        if (item.metadata?.parentConversationId === parentConversationId) {
          const conv = await this.getConversation(item.id);
          if (conv) branches.push(conv);
        }
      }
      return branches;
    }

    // Legacy fallback: scan all conversations
    const allConvs = await this.listConversations();
    const branches: IndividualConversation[] = [];
    for (const meta of allConvs) {
      const conv = await this.getConversation(meta.id);
      if (conv?.metadata?.parentConversationId === parentConversationId) {
        branches.push(conv);
      }
    }
    return branches;
  }

  /**
   * Get branches for a specific message in a conversation
   * @param parentConversationId - The parent conversation ID
   * @param parentMessageId - The message ID that was branched from
   * @returns Array of branch conversations for that message
   */
  async getBranchesForMessage(
    parentConversationId: string,
    parentMessageId: string
  ): Promise<IndividualConversation[]> {
    const allBranches = await this.getBranchConversations(parentConversationId);
    return allBranches.filter(b => b.metadata?.parentMessageId === parentMessageId);
  }

  /**
   * Get the parent conversation for a branch
   * @param branchConversationId - The branch conversation ID
   * @returns Parent conversation or null if not a branch
   */
  async getParentConversation(branchConversationId: string): Promise<IndividualConversation | null> {
    const branch = await this.getConversation(branchConversationId);
    if (!branch?.metadata?.parentConversationId) {
      return null;
    }
    return this.getConversation(branch.metadata.parentConversationId);
  }

  /**
   * Create a branch conversation (subagent or alternative)
   * @param parentConversationId - Parent conversation ID
   * @param parentMessageId - Message ID being branched from
   * @param branchType - Type of branch
   * @param title - Branch title
   * @param task - Optional task description for subagent branches
   * @param subagentMetadata - Optional full subagent metadata (for atomic creation)
   * @returns Created branch conversation
   */
  async createBranchConversation(
    parentConversationId: string,
    parentMessageId: string,
    branchType: 'subagent' | 'alternative',
    title: string,
    task?: string,
    subagentMetadata?: Record<string, unknown>
  ): Promise<IndividualConversation> {
    const branchId = `branch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const branch = await this.createConversation({
      id: branchId,
      title,
      messages: [],
      metadata: {
        parentConversationId,
        parentMessageId,
        branchType,
        subagentTask: task,
        subagent: subagentMetadata,  // Full subagent state (atomic creation)
        inheritContext: false,
      }
    });

    return branch;
  }

  /**
   * Check if a conversation is a branch
   */
  isBranch(conversation: IndividualConversation): boolean {
    return !!conversation.metadata?.parentConversationId;
  }
}
