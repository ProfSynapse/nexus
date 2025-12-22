/**
 * BranchService - Branch management for human and subagent branches
 *
 * A branch IS a conversation with parent metadata:
 * - metadata.parentConversationId: parent conversation
 * - metadata.parentMessageId: message the branch is attached to
 * - metadata.branchType: 'alternative' | 'subagent'
 *
 * Uses ConversationService as the storage backend (facade pattern).
 */

import type { Conversation, ChatMessage } from '../../types/chat/ChatTypes';
import type {
  ConversationBranch,
  BranchState,
  SubagentBranchMetadata,
  HumanBranchMetadata,
} from '../../types/branch/BranchTypes';
import type { ConversationService, IndividualConversation } from '../ConversationService';

/**
 * Dependencies for BranchService
 */
export interface BranchServiceDependencies {
  /**
   * ConversationService for branch storage (branches are conversations with parent metadata)
   */
  conversationService: ConversationService;
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
  private conversationService: ConversationService;

  constructor(dependencies: BranchServiceDependencies) {
    this.conversationService = dependencies.conversationService;
  }

  /**
   * Create a human branch (with inherited context)
   * Creates a new conversation with parent metadata
   */
  async createHumanBranch(
    conversationId: string,
    messageId: string,
    description?: string
  ): Promise<string> {
    const title = description || 'Alternative response';
    const branch = await this.conversationService.createBranchConversation(
      conversationId,
      messageId,
      'alternative',
      title
    );

    // Store inheritContext in metadata for buildLLMContext
    if (branch.metadata) {
      branch.metadata.inheritContext = true;
    }

    return branch.id;
  }

  /**
   * Create a subagent branch (fresh context)
   * Creates a new conversation with parent metadata and subagent task info
   */
  async createSubagentBranch(
    conversationId: string,
    messageId: string,
    task: string,
    subagentId: string,
    maxIterations: number = 10
  ): Promise<string> {
    const now = Date.now();
    const title = `Subagent: ${task.slice(0, 50)}${task.length > 50 ? '...' : ''}`;

    const branch = await this.conversationService.createBranchConversation(
      conversationId,
      messageId,
      'subagent',
      title,
      task
    );

    // Store subagent-specific metadata
    if (branch.metadata) {
      const subagentMeta: SubagentBranchMetadata = {
        task,
        subagentId,
        state: 'running',
        iterations: 0,
        maxIterations,
        startedAt: now,
      };
      branch.metadata.subagent = subagentMeta;
      branch.metadata.inheritContext = false;
    }

    return branch.id;
  }

  /**
   * Add a message to a branch
   * A branch IS a conversation, so this adds a message to the branch conversation
   */
  async addMessageToBranch(
    branchId: string,
    message: ChatMessage
  ): Promise<void> {
    await this.conversationService.addMessage({
      conversationId: branchId,
      id: message.id,
      role: message.role as 'user' | 'assistant' | 'tool',
      content: message.content || '',
      toolCalls: message.toolCalls,
      metadata: message.metadata,
    });
  }

  /**
   * Update a message in a branch (for streaming updates)
   * branchId IS the conversation ID
   */
  async updateMessageInBranch(
    branchId: string,
    messageId: string,
    updates: {
      content?: string;
      state?: string;
      toolCalls?: ChatMessage['toolCalls'];
      reasoning?: string;
    }
  ): Promise<void> {
    await this.conversationService.updateMessage(branchId, messageId, {
      content: updates.content,
      state: updates.state as ChatMessage['state'],
      toolCalls: updates.toolCalls,
      reasoning: updates.reasoning,
    });
  }

  /**
   * Build LLM context for a branch
   * This is the key method that handles inheritContext logic
   *
   * In the new architecture, a branch IS a conversation with parent metadata.
   * - inheritContext=true: include parent messages up to branch point
   * - inheritContext=false: only branch messages (fresh context for subagents)
   *
   * @param parentConversation The parent conversation (for inherited context)
   * @param branchId The branch conversation ID
   * @returns Array of messages to send to the LLM
   */
  async buildLLMContext(
    parentConversation: Conversation,
    branchId: string
  ): Promise<ChatMessage[]> {
    // Get the branch conversation
    const branchConversation = await this.conversationService.getConversation(branchId);
    if (!branchConversation) {
      return [];
    }

    // Convert branch messages to ChatMessage format (add conversationId)
    const branchMessages: ChatMessage[] = branchConversation.messages.map(m => ({
      ...m,
      conversationId: branchId,
    })) as ChatMessage[];

    // Check inheritContext from metadata
    const inheritContext = branchConversation.metadata?.inheritContext !== false;
    const parentMessageId = branchConversation.metadata?.parentMessageId;

    if (inheritContext && parentMessageId) {
      // Human branch: parent context (messages 0 to parent message) + branch messages
      const parentIndex = parentConversation.messages.findIndex(m => m.id === parentMessageId);
      if (parentIndex >= 0) {
        const parentContext = parentConversation.messages.slice(0, parentIndex + 1);
        return [...parentContext, ...branchMessages];
      }
    }

    // Subagent branch or parent not found: only branch messages
    return branchMessages;
  }

  /**
   * Get a branch by ID
   * In new architecture, branchId IS the conversation ID
   */
  async getBranch(
    parentConversationId: string,
    branchId: string
  ): Promise<BranchInfo | null> {
    const branchConversation = await this.conversationService.getConversation(branchId);
    if (!branchConversation) {
      return null;
    }

    // Verify this is a branch of the specified parent
    if (branchConversation.metadata?.parentConversationId !== parentConversationId) {
      return null;
    }

    const branch = this.conversationToBranch(branchConversation);

    return {
      branch,
      parentMessageId: branchConversation.metadata?.parentMessageId || '',
    };
  }

  /**
   * Convert a branch conversation to ConversationBranch format
   */
  private conversationToBranch(conversation: IndividualConversation): ConversationBranch {
    const branchType = conversation.metadata?.branchType === 'subagent' ? 'subagent' : 'human';
    const inheritContext = conversation.metadata?.inheritContext !== false;

    // Convert ConversationMessage[] to ChatMessage[] (add conversationId)
    const messages = conversation.messages.map(m => ({
      ...m,
      conversationId: conversation.id,
    })) as ChatMessage[];

    return {
      id: conversation.id,
      type: branchType,
      inheritContext,
      messages,
      metadata: branchType === 'subagent'
        ? conversation.metadata?.subagent as SubagentBranchMetadata
        : { description: conversation.title } as HumanBranchMetadata,
      created: conversation.created,
      updated: conversation.updated,
    };
  }

  /**
   * Update branch metadata (subagent state, iterations, etc.)
   * branchId IS the conversation ID
   */
  async updateBranchMetadata(
    branchId: string,
    metadata: Partial<SubagentBranchMetadata>
  ): Promise<void> {
    const branchConversation = await this.conversationService.getConversation(branchId);
    if (!branchConversation) {
      throw new Error(`Branch not found: ${branchId}`);
    }

    // Merge with existing subagent metadata
    const existingSubagent = branchConversation.metadata?.subagent || {};
    const updatedSubagent = {
      ...existingSubagent,
      ...metadata,
    };

    // Update via ConversationService
    await this.conversationService.updateConversation(branchId, {
      metadata: {
        ...branchConversation.metadata,
        subagent: updatedSubagent,
      },
    });
  }

  /**
   * Update branch state (convenience method for subagent state transitions)
   */
  async updateBranchState(
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

    await this.updateBranchMetadata(branchId, updates);
  }

  /**
   * Get all branches for a conversation
   * Uses ConversationService.getBranchConversations
   */
  async getAllBranches(conversationId: string): Promise<BranchInfo[]> {
    const branches = await this.conversationService.getBranchConversations(conversationId);
    return this.convertConversationsToBranchInfoArray(branches);
  }

  /**
   * Get all subagent branches (for UI status display)
   */
  async getSubagentBranches(conversationId: string): Promise<BranchInfo[]> {
    const allBranches = await this.conversationService.getBranchConversations(conversationId);
    const subagentBranches = allBranches.filter(b => b.metadata?.branchType === 'subagent');
    return this.convertConversationsToBranchInfoArray(subagentBranches);
  }

  /**
   * Get branches attached to a specific message
   * Note: This requires searching by parent message ID - less efficient than message-level queries
   */
  async getBranchesByMessage(parentMessageId: string): Promise<BranchInfo[]> {
    // Get all conversations and filter for branches from this message
    // This is less efficient but works with the new architecture
    const allConversations = await this.conversationService.listConversations(undefined, 200);
    const branchInfos: BranchInfo[] = [];

    for (const meta of allConversations) {
      // Need to load full conversation to check metadata
      const conversation = await this.conversationService.getConversation(meta.id);
      if (conversation?.metadata?.parentMessageId === parentMessageId) {
        branchInfos.push({
          branch: this.conversationToBranch(conversation),
          parentMessageId,
        });
      }
    }

    return branchInfos;
  }

  /**
   * Convert conversation array to BranchInfo array
   */
  private convertConversationsToBranchInfoArray(conversations: IndividualConversation[]): BranchInfo[] {
    return conversations.map(c => ({
      branch: this.conversationToBranch(c),
      parentMessageId: c.metadata?.parentMessageId || '',
    }));
  }

}
