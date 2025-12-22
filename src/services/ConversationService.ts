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
import { IStorageAdapter } from '../database/interfaces/IStorageAdapter';
import { ConversationMetadata, MessageData } from '../types/storage/HybridStorageTypes';
import { PaginationParams, PaginatedResult, calculatePaginationMetadata } from '../types/pagination/PaginationTypes';
import { branchMigrationService } from './migration/BranchMigrationService';
import type { ConversationBranch } from '../types/branch/BranchTypes';

export class ConversationService {
  constructor(
    private plugin: Plugin,
    private fileSystem: FileSystemService,
    private indexManager: IndexManager,
    private storageAdapter?: IStorageAdapter
  ) {}

  /**
   * List conversations (uses index only - lightweight and fast)
   */
  async listConversations(vaultName?: string, limit?: number): Promise<LegacyConversationMetadata[]> {
    // Use adapter if available
    if (this.storageAdapter) {
      const result = await this.storageAdapter.getConversations({
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
    // Use adapter if available
    if (this.storageAdapter) {
      const metadata = await this.storageAdapter.getConversation(id);
      if (!metadata) {
        return null;
      }

      // Apply pagination or load all messages (default: first 1000 for backward compatibility)
      const messagesResult = await this.storageAdapter.getMessages(id, {
        page: paginationOptions?.page ?? 0,
        pageSize: paginationOptions?.pageSize ?? 1000
      });

      // Convert to legacy format
      const conversation = this.convertToLegacyConversation(metadata, messagesResult.items);

      // Populate message.branches from branch storage
      // This connects branches (stored separately) to their parent messages for navigation
      await this.populateMessageBranches(conversation.messages);

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

    // Migration: Convert alternatives[] to branches[] structure
    // This migrates from the old message alternatives system to unified branches
    const migrationResult = branchMigrationService.migrateConversation(conversation as any);
    if (migrationResult.migrated) {
      // Save the migrated conversation to persist the changes
      // This ensures we don't re-migrate on every load
      try {
        await this.fileSystem.writeConversation(id, conversation);
        console.log(`[ConversationService] Migrated ${migrationResult.messagesUpdated} messages with ${migrationResult.branchesCreated} branches for conversation ${id}`);
      } catch (error) {
        // Log but don't fail - migration will be retried on next load
        console.warn(`[ConversationService] Failed to persist branch migration for ${id}:`, error);
      }
    }

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
    // Use adapter if available
    if (this.storageAdapter) {
      const messagesResult = await this.storageAdapter.getMessages(conversationId, {
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

    // Use adapter if available
    if (this.storageAdapter) {
      const conversationId = await this.storageAdapter.createConversation({
        title: data.title || 'Untitled Conversation',
        created: data.created ?? Date.now(),
        updated: data.updated ?? Date.now(),
        vaultName: data.vault_name || this.plugin.app.vault.getName(),
        workspaceId: data.metadata?.chatSettings?.workspaceId,
        sessionId: data.metadata?.chatSettings?.sessionId
      });

      // Get created conversation
      const metadata = await this.storageAdapter.getConversation(conversationId);
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
    // Use adapter if available
    if (this.storageAdapter) {
      // Merge existing metadata so we don't lose chat settings when only cost is updated
      const existing = await this.storageAdapter.getConversation(id);
      const existingMetadata = existing?.metadata || {};

      const mergedMetadata = {
        ...existingMetadata,
        chatSettings: {
          ...(existingMetadata.chatSettings || {}),
          ...(updates.metadata?.chatSettings || {}),
          workspaceId: updates.metadata?.chatSettings?.workspaceId ?? existingMetadata.chatSettings?.workspaceId,
          sessionId: updates.metadata?.chatSettings?.sessionId ?? existingMetadata.chatSettings?.sessionId
        },
        cost: updates.cost || existingMetadata.cost
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

          await this.storageAdapter.updateMessage(id, msg.id, {
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
        await this.storageAdapter.updateConversation(id, {
          title: updates.title,
          updated: updates.updated ?? Date.now(),
          workspaceId: updates.metadata?.chatSettings?.workspaceId,
          sessionId: updates.metadata?.chatSettings?.sessionId,
          metadata: mergedMetadata
        });
      } else {
        // Metadata-only update
        await this.storageAdapter.updateConversation(id, {
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
    // Use adapter if available
    if (this.storageAdapter) {
      await this.storageAdapter.deleteConversation(id);
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
      // Use adapter if available
      if (this.storageAdapter) {
        // Determine initial state based on role and content
        let initialState: 'draft' | 'complete' = 'complete';
        if (params.role === 'assistant' && (!params.content || params.content.trim() === '')) {
          // Empty assistant messages are placeholders for streaming
          initialState = 'draft';
        }

        const messageId = await this.storageAdapter.addMessage(params.conversationId, {
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
   * Search conversations (uses adapter FTS or legacy index)
   */
  async searchConversations(query: string, limit?: number): Promise<LegacyConversationMetadata[]> {
    if (!query) {
      return this.listConversations(undefined, limit);
    }

    // Use adapter if available
    if (this.storageAdapter) {
      const results = await this.storageAdapter.searchConversations(query);
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
   * Populate message.branches from branch storage
   *
   * This connects branches (stored separately in branches table) to their parent messages.
   * Required for MessageBranchNavigator to show branch navigation on messages.
   * Works for both human branches and subagent branches.
   */
  private async populateMessageBranches(messages: ConversationMessage[]): Promise<void> {
    if (!this.storageAdapter) {
      return;
    }

    const branchRepository = this.storageAdapter.getBranchRepository();

    // For each message, query its branches and attach them
    for (const message of messages) {
      const branchDataList = await branchRepository.getBranchesByMessage(message.id);

      if (branchDataList.length > 0) {
        // Convert each BranchData to ConversationBranch (includes messages)
        const branches: ConversationBranch[] = [];
        for (const branchData of branchDataList) {
          const fullBranch = await branchRepository.toConversationBranch(branchData.id);
          if (fullBranch) {
            branches.push(fullBranch);
          }
        }

        if (branches.length > 0) {
          message.branches = branches;
          // Initialize activeAlternativeIndex if not set (0 = original message)
          if (message.activeAlternativeIndex === undefined) {
            message.activeAlternativeIndex = 0;
          }
        }
      }
    }
  }

  /**
   * Convert new ConversationMetadata + MessageData[] to legacy IndividualConversation
   */
  private convertToLegacyConversation(
    metadata: ConversationMetadata,
    messages: MessageData[]
  ): IndividualConversation {
    const meta = metadata.metadata || {};
    const resolvedCost = meta.cost || (meta.totalCost !== undefined ? { totalCost: meta.totalCost, currency: meta.currency || 'USD' } : undefined);
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
      metadata: {
        chatSettings: {
          workspaceId: metadata.workspaceId,
          sessionId: metadata.sessionId
        },
        cost: resolvedCost
      },
      cost: resolvedCost
    };
  }
}
