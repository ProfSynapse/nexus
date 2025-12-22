/**
 * BranchService - Unified branch management for human and subagent branches
 *
 * Responsibilities:
 * - Create branches on messages (human or subagent)
 * - Add messages to branches
 * - Build LLM context based on inheritContext flag
 * - Update branch metadata/state
 * - Query branches
 *
 * Architecture:
 * - Uses BranchRepository for persistence (JSONL events + SQLite cache)
 * - Append-only writes eliminate race conditions (no retry logic needed)
 * - Branches stored separately from messages for conflict-free sync
 *
 * Follows Single Responsibility Principle - only handles branch operations.
 */

import type { Conversation, ChatMessage } from '../../types/chat/ChatTypes';
import type {
  ConversationBranch,
  BranchState,
  SubagentBranchMetadata,
  HumanBranchMetadata,
} from '../../types/branch/BranchTypes';
import type { BranchRepository, BranchData } from '../../database/repositories/BranchRepository';

/**
 * Dependencies for BranchService
 */
export interface BranchServiceDependencies {
  branchRepository: BranchRepository;
  /**
   * Optional: conversation service for buildLLMContext (needs parent messages)
   * Only required if using buildLLMContext with inheritContext=true
   */
  conversationService?: {
    getConversation(id: string): Promise<Conversation | null>;
  };
}

/**
 * Branch info returned by query methods
 */
export interface BranchInfo {
  branch: ConversationBranch;
  parentMessageId: string;
  /**
   * Index of parent message in conversation (for LLM context building)
   * Note: This is calculated dynamically if needed, not stored
   */
  parentMessageIndex?: number;
}

export class BranchService {
  private repository: BranchRepository;
  private conversationService?: BranchServiceDependencies['conversationService'];

  constructor(dependencies: BranchServiceDependencies) {
    this.repository = dependencies.branchRepository;
    this.conversationService = dependencies.conversationService;
  }

  /**
   * Create a human branch (with inherited context)
   */
  async createHumanBranch(
    conversationId: string,
    messageId: string,
    description?: string
  ): Promise<string> {
    const metadata: HumanBranchMetadata | undefined = description
      ? { description }
      : undefined;

    return this.repository.createBranch({
      conversationId,
      parentMessageId: messageId,
      type: 'human',
      inheritContext: true,
      metadata,
    });
  }

  /**
   * Create a subagent branch (fresh context)
   */
  async createSubagentBranch(
    conversationId: string,
    messageId: string,
    task: string,
    subagentId: string,
    maxIterations: number = 10
  ): Promise<string> {
    const now = Date.now();
    const metadata: SubagentBranchMetadata = {
      task,
      subagentId,
      state: 'running',
      iterations: 0,
      maxIterations,
      startedAt: now,
    };

    return this.repository.createBranch({
      conversationId,
      parentMessageId: messageId,
      type: 'subagent',
      inheritContext: false,
      metadata,
    });
  }

  /**
   * Add a message to a branch
   * No retry logic needed - append-only events are conflict-free
   */
  async addMessageToBranch(
    conversationId: string,
    _parentMessageId: string, // Kept for API compatibility, not used
    branchId: string,
    message: ChatMessage
  ): Promise<void> {
    await this.repository.addBranchMessage(conversationId, branchId, {
      id: message.id,
      role: message.role as 'system' | 'user' | 'assistant' | 'tool',
      content: message.content || null,
      timestamp: message.timestamp,
      state: message.state,
      toolCalls: message.toolCalls?.map(tc => ({
        id: tc.id,
        type: tc.type || 'function',
        function: tc.function || { name: tc.name || 'unknown', arguments: JSON.stringify(tc.parameters || {}) },
        name: tc.name,
        parameters: tc.parameters,
        result: tc.result,
        success: tc.success,
        error: tc.error,
      })),
      // toolCallId is in storage format but not in ChatMessage - extract from metadata if needed
      toolCallId: (message.metadata as { toolCallId?: string } | undefined)?.toolCallId,
      reasoning: message.reasoning,
    });
  }

  /**
   * Update a message in a branch (for streaming updates)
   */
  async updateMessageInBranch(
    conversationId: string,
    branchId: string,
    messageId: string,
    updates: {
      content?: string;
      state?: string;
      toolCalls?: ChatMessage['toolCalls'];
      reasoning?: string;
    }
  ): Promise<void> {
    await this.repository.updateBranchMessage(conversationId, branchId, messageId, {
      content: updates.content,
      state: updates.state,
      reasoning: updates.reasoning,
      toolCalls: updates.toolCalls?.map(tc => ({
        id: tc.id,
        type: tc.type || 'function',
        function: tc.function || { name: tc.name || 'unknown', arguments: JSON.stringify(tc.parameters || {}) },
        result: tc.result,
        success: tc.success,
        error: tc.error,
      })),
    });
  }

  /**
   * Build LLM context for a branch
   * This is the key method that handles inheritContext logic
   *
   * @param conversation The full conversation (required for parent context)
   * @param branchId The branch to build context for
   * @returns Array of messages to send to the LLM
   */
  async buildLLMContext(
    conversation: Conversation,
    branchId: string
  ): Promise<ChatMessage[]> {
    const branchWithMessages = await this.repository.getBranchWithMessages(branchId);
    if (!branchWithMessages) {
      return [];
    }

    const { branch, messages } = branchWithMessages;

    // Convert branch messages to ChatMessage format
    // Note: BranchMessageData has toolCallId, but ChatMessage doesn't - stored in metadata
    const branchMessages: ChatMessage[] = messages.map(m => {
      // Map storage state to ChatMessage state
      let state: ChatMessage['state'];
      switch (m.state) {
        case 'streaming':
        case 'running':
          state = 'streaming';
          break;
        case 'draft':
          state = 'draft';
          break;
        case 'complete':
          state = 'complete';
          break;
        case 'cancelled':
        case 'aborted':
          state = 'aborted';
          break;
        case 'error':
        case 'invalid':
          state = 'invalid';
          break;
        default:
          state = 'complete';
      }

      return {
        id: m.id,
        conversationId: m.conversationId,
        role: m.role as 'user' | 'assistant' | 'tool',
        content: m.content ?? '',
        timestamp: m.timestamp,
        state,
        toolCalls: m.toolCalls?.map(tc => ({
          id: tc.id,
          type: tc.type || 'function',
          name: tc.name || tc.function?.name || 'unknown',
          function: tc.function,
          parameters: tc.parameters || {},
          result: tc.result,
          success: tc.success,
          error: tc.error,
        })),
        reasoning: m.reasoning,
        // Store toolCallId in metadata for tool role messages
        metadata: m.toolCallId ? { toolCallId: m.toolCallId } : undefined,
      };
    });

    if (branch.inheritContext) {
      // Human branch: parent context (messages 0 to parent message) + branch messages
      const parentIndex = conversation.messages.findIndex(m => m.id === branch.parentMessageId);
      if (parentIndex >= 0) {
        const parentContext = conversation.messages.slice(0, parentIndex + 1);
        return [...parentContext, ...branchMessages];
      }
      // Fallback: just return branch messages if parent not found
      return branchMessages;
    } else {
      // Subagent branch: only branch messages (fresh context)
      return branchMessages;
    }
  }

  /**
   * Get a branch by ID
   * No retry logic needed - direct SQLite query
   */
  async getBranch(
    conversationId: string,
    branchId: string
  ): Promise<BranchInfo | null> {
    const branch = await this.repository.toConversationBranch(branchId);
    if (!branch) {
      return null;
    }

    // Get the parent message ID from the branch data
    const branchData = await this.repository.getById(branchId);
    if (!branchData || branchData.conversationId !== conversationId) {
      return null;
    }

    return {
      branch,
      parentMessageId: branchData.parentMessageId,
    };
  }

  /**
   * Update branch metadata
   * No retry logic needed - append-only events are conflict-free
   */
  async updateBranchMetadata(
    conversationId: string,
    branchId: string,
    metadata: Partial<SubagentBranchMetadata>
  ): Promise<void> {
    // Get current branch to merge metadata
    const branchData = await this.repository.getById(branchId);
    if (!branchData) {
      throw new Error(`Branch not found: ${branchId}`);
    }
    if (branchData.conversationId !== conversationId) {
      throw new Error(`Branch ${branchId} does not belong to conversation ${conversationId}`);
    }

    const updatedMetadata = {
      ...branchData.metadata,
      ...metadata,
    } as SubagentBranchMetadata;

    await this.repository.updateBranch(branchId, updatedMetadata);
  }

  /**
   * Update branch state (convenience method for subagent state transitions)
   */
  async updateBranchState(
    conversationId: string,
    branchId: string,
    state: BranchState,
    iterations?: number
  ): Promise<void> {
    const updates: Partial<SubagentBranchMetadata> = { state };

    if (iterations !== undefined) {
      updates.iterations = iterations;
    }

    if (state === 'complete' || state === 'cancelled' || state === 'abandoned') {
      updates.completedAt = Date.now();
    }

    await this.updateBranchMetadata(conversationId, branchId, updates);
  }

  /**
   * Get all branches for a conversation
   */
  async getAllBranches(conversationId: string): Promise<BranchInfo[]> {
    const branches = await this.repository.getBranchesByConversation(conversationId);
    return this.convertBranchDataToInfoArray(branches);
  }

  /**
   * Get all subagent branches (for UI status display)
   */
  async getSubagentBranches(conversationId: string): Promise<BranchInfo[]> {
    const branches = await this.repository.getSubagentBranches(conversationId);
    return this.convertBranchDataToInfoArray(branches);
  }

  /**
   * Get branches attached to a specific message
   */
  async getBranchesByMessage(parentMessageId: string): Promise<BranchInfo[]> {
    const branches = await this.repository.getBranchesByMessage(parentMessageId);
    return this.convertBranchDataToInfoArray(branches);
  }

  /**
   * Convert BranchData array to BranchInfo array
   */
  private async convertBranchDataToInfoArray(branches: BranchData[]): Promise<BranchInfo[]> {
    const results: BranchInfo[] = [];

    for (const branchData of branches) {
      const branch = await this.repository.toConversationBranch(branchData.id);
      if (branch) {
        results.push({
          branch,
          parentMessageId: branchData.parentMessageId,
        });
      }
    }

    return results;
  }

  // ============================================================================
  // Legacy Compatibility Methods
  // ============================================================================

  /**
   * @deprecated Use buildLLMContext instead
   * Synchronous version for backward compatibility - returns empty if branch not cached
   */
  buildLLMContextSync(
    conversation: Conversation,
    branchId: string
  ): ChatMessage[] {
    // For backward compatibility, search in embedded branches (legacy format)
    const branchInfo = this.findBranchInConversation(conversation, branchId);
    if (!branchInfo) {
      return [];
    }

    const { branch, parentMessageIndex } = branchInfo;

    if (branch.inheritContext) {
      const parentContext = conversation.messages.slice(0, parentMessageIndex + 1);
      return [...parentContext, ...branch.messages];
    } else {
      return [...branch.messages];
    }
  }

  /**
   * @deprecated Legacy helper for finding embedded branches
   * Only used for backward compatibility with old conversation format
   */
  private findBranchInConversation(
    conversation: Conversation,
    branchId: string
  ): (BranchInfo & { parentMessageIndex: number }) | null {
    for (let i = 0; i < conversation.messages.length; i++) {
      const message = conversation.messages[i];
      if (message.branches) {
        const branch = message.branches.find(b => b.id === branchId);
        if (branch) {
          return {
            branch,
            parentMessageId: message.id,
            parentMessageIndex: i,
          };
        }
      }
    }
    return null;
  }
}
