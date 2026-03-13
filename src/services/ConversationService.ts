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
import { ConversationMetadata } from '../types/storage/HybridStorageTypes';
import { PaginationParams, PaginatedResult, calculatePaginationMetadata } from '../types/pagination/PaginationTypes';
import { StorageAdapterOrGetter, resolveAdapter, withDualBackend } from './helpers/DualBackendExecutor';
import { convertToLegacyMetadata, convertToLegacyConversation, populateMessageBranches } from './helpers/ConversationTypeConverters';

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
   * Resolve the storage adapter if available and ready.
   * Delegates to shared DualBackendExecutor helper.
   */
  private getReadyAdapter(): IStorageAdapter | undefined {
    return resolveAdapter(this.storageAdapterOrGetter);
  }

  /**
   * List conversations (uses index only - lightweight and fast)
   */
  async listConversations(vaultName?: string, limit?: number): Promise<LegacyConversationMetadata[]> {
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getConversations({
          filter: vaultName ? { vaultName } : undefined,
          pageSize: limit ?? 100,
          page: 0,
          sortBy: 'updated',
          sortOrder: 'desc'
        });
        return result.items.map(convertToLegacyMetadata);
      },
      async () => {
        const index = await this.indexManager.loadConversationIndex();
        let conversations = Object.values(index.conversations);
        if (vaultName) {
          conversations = conversations.filter(conv => conv.vault_name === vaultName);
        }
        conversations.sort((a, b) => b.updated - a.updated);
        if (limit) {
          conversations = conversations.slice(0, limit);
        }
        return conversations;
      }
    );
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
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const metadata = await adapter.getConversation(id);
        if (!metadata) {
          return null;
        }

        const messagesResult = await adapter.getMessages(id, {
          page: paginationOptions?.page ?? 0,
          pageSize: paginationOptions?.pageSize ?? 1000
        });

        const conversation = convertToLegacyConversation(metadata, messagesResult.items);
        const allBranches = await this.getBranchConversations(id);
        populateMessageBranches(allBranches, conversation.messages);

        if (paginationOptions) {
          conversation.messagePagination = {
            ...messagesResult,
            items: conversation.messages
          };
        }

        return conversation;
      },
      async () => {
        const conversation = await this.fileSystem.readConversation(id);
        if (!conversation) {
          return null;
        }

        if (conversation.messages && conversation.messages.length > 0) {
          conversation.messages = conversation.messages.map(msg => {
            if (!msg.state) {
              msg.state = 'complete';
            }
            return msg;
          });
        }

        if (paginationOptions) {
          const page = paginationOptions.page ?? 0;
          const pageSize = paginationOptions.pageSize ?? 50;
          const totalMessages = conversation.messages.length;
          const startIndex = page * pageSize;
          const endIndex = startIndex + pageSize;

          const paginatedMessages = conversation.messages.slice(startIndex, endIndex);
          const paginationMetadata = calculatePaginationMetadata(page, pageSize, totalMessages);

          conversation.messagePagination = {
            ...paginationMetadata,
            items: paginatedMessages
          };
          conversation.messages = paginatedMessages;
        }

        return conversation;
      }
    );
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
    return withDualBackend<PaginatedResult<any>>(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const messagesResult = await adapter.getMessages(conversationId, {
          page: options?.page ?? 0,
          pageSize: options?.pageSize ?? 50
        });

        return {
          ...messagesResult,
          items: messagesResult.items.map(msg => ({
            id: msg.id,
            role: msg.role as 'user' | 'assistant' | 'tool',
            content: msg.content || '',
            timestamp: msg.timestamp,
            state: msg.state,
            toolCalls: msg.toolCalls?.map(tc => {
              const hasFunction = tc.function && typeof tc.function === 'object';
              const name = (hasFunction ? tc.function.name : tc.name) || 'unknown_tool';
              let parameters: any;
              if (hasFunction && tc.function.arguments) {
                if (typeof tc.function.arguments === 'string') {
                  try {
                    parameters = JSON.parse(tc.function.arguments);
                  } catch {
                    // Malformed JSON in arguments — preserve raw string as-is
                    parameters = tc.function.arguments;
                  }
                } else {
                  parameters = tc.function.arguments;
                }
              } else {
                parameters = tc.parameters;
              }
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
            alternatives: msg.alternatives,
            activeAlternativeIndex: msg.activeAlternativeIndex
          }))
        };
      },
      async () => {
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
    );
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

  async hasRunKey(runKey: string): Promise<boolean> {
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getConversations({
          page: 0,
          pageSize: 1,
          filter: { runKey },
          includeBranches: true
        });
        return result.items.length > 0;
      },
      async () => {
        const conversations = await this.getAllConversations();
        return conversations.some(conversation => conversation.metadata?.runKey === runKey);
      }
    );
  }

  /**
   * Create new conversation (writes to adapter or legacy storage)
   */
  async createConversation(data: Partial<IndividualConversation>): Promise<IndividualConversation> {
    const id = data.id || `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const conversationId = await adapter.createConversation({
          title: data.title || 'Untitled Conversation',
          created: data.created ?? Date.now(),
          updated: data.updated ?? Date.now(),
          vaultName: data.vault_name || this.plugin.app.vault.getName(),
          workspaceId: data.metadata?.chatSettings?.workspaceId,
          sessionId: data.metadata?.chatSettings?.sessionId,
          workflowId: data.metadata?.workflowId as string | undefined,
          runTrigger: data.metadata?.runTrigger as 'manual' | 'scheduled' | 'catch_up' | undefined,
          scheduledFor: data.metadata?.scheduledFor as number | undefined,
          runKey: data.metadata?.runKey as string | undefined,
          metadata: data.metadata
        });

        const metadata = await adapter.getConversation(conversationId);
        if (!metadata) {
          throw new Error('Failed to retrieve created conversation');
        }

        return convertToLegacyConversation(metadata, []);
      },
      async () => {
        const conversation: IndividualConversation = {
          id,
          title: data.title || 'Untitled Conversation',
          created: data.created || Date.now(),
          updated: data.updated || Date.now(),
          vault_name: data.vault_name || this.plugin.app.vault.getName(),
          message_count: data.messages?.length || 0,
          messages: data.messages || [],
          metadata: data.metadata
        };

        await this.fileSystem.writeConversation(id, conversation);
        await this.indexManager.updateConversationInIndex(conversation);
        return conversation;
      }
    );
  }

  /**
   * Update conversation (updates adapter or legacy storage)
   */
  async updateConversation(id: string, updates: Partial<IndividualConversation>): Promise<void> {
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        // Merge existing metadata so we don't lose chat settings when only cost is updated
        const existing = await adapter.getConversation(id);
        type ChatSettingsType = NonNullable<IndividualConversation['metadata']>['chatSettings'];
        const existingMetadata = (existing?.metadata ?? {}) as IndividualConversation['metadata'];
        const existingChatSettings = (existingMetadata?.chatSettings ?? {}) as ChatSettingsType;
        const updatesChatSettings = (updates.metadata?.chatSettings ?? {}) as ChatSettingsType;

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

        if (updates.messages && updates.messages.length > 0) {
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

            await adapter.updateMessage(id, msg.id, {
              content: msg.content ?? null,
              state: msg.state,
              reasoning: msg.reasoning,
              toolCalls: convertedToolCalls,
              toolCallId: msg.toolCallId,
              alternatives: msg.alternatives as unknown as import('../types/storage/HybridStorageTypes').AlternativeMessage[] | undefined,
              activeAlternativeIndex: msg.activeAlternativeIndex
            });
          }
        }

        await adapter.updateConversation(id, {
          title: updates.title,
          updated: updates.updated ?? Date.now(),
          workspaceId: updates.metadata?.chatSettings?.workspaceId,
          sessionId: updates.metadata?.chatSettings?.sessionId,
          workflowId: updates.metadata?.workflowId as string | undefined,
          runTrigger: updates.metadata?.runTrigger as 'manual' | 'scheduled' | 'catch_up' | undefined,
          scheduledFor: updates.metadata?.scheduledFor as number | undefined,
          runKey: updates.metadata?.runKey as string | undefined,
          metadata: mergedMetadata
        });
      },
      async () => {
        const conversation = await this.fileSystem.readConversation(id);
        if (!conversation) {
          throw new Error(`Conversation ${id} not found`);
        }

        const updatedConversation: IndividualConversation = {
          ...conversation,
          ...updates,
          id,
          updated: Date.now(),
          message_count: updates.messages?.length ?? conversation.message_count
        };

        await this.fileSystem.writeConversation(id, updatedConversation);
        await this.indexManager.updateConversationInIndex(updatedConversation);
      }
    );
  }

  /**
   * Delete conversation (deletes from adapter or legacy storage)
   */
  async deleteConversation(id: string): Promise<void> {
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        await adapter.deleteConversation(id);
      },
      async () => {
        await this.fileSystem.deleteConversation(id);
        await this.indexManager.removeConversationFromIndex(id);
      }
    );
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
    id?: string;
    metadata?: any;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      return await withDualBackend(
        this.storageAdapterOrGetter,
        async (adapter) => {
          let initialState: 'draft' | 'complete' = 'complete';
          if (params.role === 'assistant' && (!params.content || params.content.trim() === '')) {
            initialState = 'draft';
          }

          const messageId = await adapter.addMessage(params.conversationId, {
            id: params.id,
            role: params.role,
            content: params.content,
            timestamp: Date.now(),
            state: initialState,
            toolCalls: params.toolCalls,
            metadata: params.metadata
          });

          return { success: true, messageId } as { success: boolean; messageId?: string; error?: string };
        },
        async () => {
          const conversation = await this.fileSystem.readConversation(params.conversationId);
          if (!conversation) {
            return { success: false, error: `Conversation ${params.conversationId} not found` };
          }

          const messageId = params.id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          let initialState: 'draft' | 'complete' = 'complete';
          if (params.role === 'assistant' && (!params.content || params.content.trim() === '')) {
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

          conversation.messages.push(message);
          conversation.message_count = conversation.messages.length;
          conversation.updated = Date.now();

          if (params.cost) {
            conversation.metadata = conversation.metadata || {};
            conversation.metadata.totalCost = (conversation.metadata.totalCost || 0) + params.cost.totalCost;
            conversation.metadata.currency = params.cost.currency;
          }

          if (params.usage) {
            conversation.metadata = conversation.metadata || {};
            conversation.metadata.totalTokens = (conversation.metadata.totalTokens || 0) + params.usage.totalTokens;
          }

          await this.fileSystem.writeConversation(params.conversationId, conversation);
          await this.indexManager.updateConversationInIndex(conversation);

          return { success: true, messageId };
        }
      );
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
      return await withDualBackend(
        this.storageAdapterOrGetter,
        async (adapter) => {
          await adapter.updateMessage(conversationId, messageId, updates);
          return { success: true } as { success: boolean; error?: string };
        },
        async () => {
          const conversation = await this.fileSystem.readConversation(conversationId);
          if (!conversation) {
            return { success: false, error: `Conversation ${conversationId} not found` };
          }

          const messageIndex = conversation.messages.findIndex(m => m.id === messageId);
          if (messageIndex === -1) {
            return { success: false, error: `Message ${messageId} not found` };
          }

          const message = conversation.messages[messageIndex];
          if (updates.content !== undefined) message.content = updates.content;
          if (updates.state !== undefined) message.state = updates.state;
          if (updates.toolCalls !== undefined) message.toolCalls = updates.toolCalls;
          if (updates.reasoning !== undefined) message.reasoning = updates.reasoning;

          conversation.updated = Date.now();
          await this.fileSystem.writeConversation(conversationId, conversation);
          return { success: true };
        }
      );
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

    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const results = await adapter.searchConversations(query);
        const converted = results.map(convertToLegacyMetadata);
        return limit ? converted.slice(0, limit) : converted;
      },
      async () => {
        const index = await this.indexManager.loadConversationIndex();
        const words = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
        const matchedIds = new Set<string>();

        for (const word of words) {
          if (index.byTitle[word]) {
            index.byTitle[word].forEach((id: string) => matchedIds.add(id));
          }
          if (index.byContent[word]) {
            index.byContent[word].forEach((id: string) => matchedIds.add(id));
          }
        }

        const results = Array.from(matchedIds)
          .map(id => index.conversations[id])
          .filter(conv => conv !== undefined)
          .sort((a, b) => b.updated - a.updated);

        return limit ? results.slice(0, limit) : results;
      }
    );
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
    return withDualBackend(
      this.storageAdapterOrGetter,
      async (adapter) => {
        const result = await adapter.getConversations({
          pageSize: 100,
          page: 0,
          sortBy: 'created',
          sortOrder: 'asc',
          includeBranches: true
        });

        const branches: IndividualConversation[] = [];
        for (const item of result.items) {
          if (item.metadata?.parentConversationId === parentConversationId) {
            const conv = await this.getConversation(item.id);
            if (conv) branches.push(conv);
          }
        }
        return branches;
      },
      async () => {
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
    );
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
