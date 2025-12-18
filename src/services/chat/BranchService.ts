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
 * Follows Single Responsibility Principle - only handles branch operations.
 */

import type { Conversation, ChatMessage } from '../../types/chat/ChatTypes';
import type {
  ConversationBranch,
  BranchState,
  SubagentBranchMetadata,
} from '../../types/branch/BranchTypes';

export interface BranchServiceDependencies {
  conversationService: {
    getConversation(id: string): Promise<Conversation | null>;
    updateConversation(id: string, data: Partial<Conversation>): Promise<void>;
  };
}

export interface BranchInfo {
  branch: ConversationBranch;
  parentMessageId: string;
  parentMessageIndex: number;
}

export class BranchService {
  constructor(private dependencies: BranchServiceDependencies) {}

  /**
   * Create a new branch on a message
   */
  async createBranch(
    conversationId: string,
    messageId: string,
    branch: ConversationBranch
  ): Promise<void> {
    const conversation = await this.dependencies.conversationService.getConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const message = conversation.messages.find(m => m.id === messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }

    if (!message.branches) {
      message.branches = [];
    }
    message.branches.push(branch);

    await this.dependencies.conversationService.updateConversation(conversationId, {
      messages: conversation.messages,
    });
  }

  /**
   * Create a human branch (with inherited context)
   */
  async createHumanBranch(
    conversationId: string,
    messageId: string,
    description?: string
  ): Promise<string> {
    const branchId = `branch_human_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();

    const branch: ConversationBranch = {
      id: branchId,
      type: 'human',
      inheritContext: true,
      messages: [],
      created: now,
      updated: now,
      metadata: description ? { description } : undefined,
    };

    await this.createBranch(conversationId, messageId, branch);
    return branchId;
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
    const branchId = `branch_subagent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();

    const branch: ConversationBranch = {
      id: branchId,
      type: 'subagent',
      inheritContext: false,
      messages: [],
      created: now,
      updated: now,
      metadata: {
        task,
        subagentId,
        state: 'running',
        iterations: 0,
        maxIterations,
        startedAt: now,
      } satisfies SubagentBranchMetadata,
    };

    await this.createBranch(conversationId, messageId, branch);
    return branchId;
  }

  /**
   * Add a message to a branch
   */
  async addMessageToBranch(
    conversationId: string,
    parentMessageId: string,
    branchId: string,
    message: ChatMessage
  ): Promise<void> {
    const conversation = await this.dependencies.conversationService.getConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const parentMessage = conversation.messages.find(m => m.id === parentMessageId);
    if (!parentMessage) {
      throw new Error(`Parent message not found: ${parentMessageId}`);
    }

    const branch = parentMessage.branches?.find(b => b.id === branchId);
    if (!branch) {
      throw new Error(`Branch not found: ${branchId}`);
    }

    branch.messages.push(message);
    branch.updated = Date.now();

    await this.dependencies.conversationService.updateConversation(conversationId, {
      messages: conversation.messages,
    });
  }

  /**
   * Build LLM context for a branch
   * This is the key method that handles inheritContext logic
   *
   * @param conversation The full conversation
   * @param branchId The branch to build context for
   * @returns Array of messages to send to the LLM
   */
  buildLLMContext(
    conversation: Conversation,
    branchId: string
  ): ChatMessage[] {
    const branchInfo = this.findBranchInConversation(conversation, branchId);
    if (!branchInfo) {
      return [];
    }

    const { branch, parentMessageIndex } = branchInfo;

    if (branch.inheritContext) {
      // Human branch: parent context (messages 0 to parentIndex inclusive) + branch messages
      const parentContext = conversation.messages.slice(0, parentMessageIndex + 1);
      return [...parentContext, ...branch.messages];
    } else {
      // Subagent branch: only branch messages (fresh context)
      return [...branch.messages];
    }
  }

  /**
   * Get a branch by ID (searches all messages)
   */
  async getBranch(
    conversationId: string,
    branchId: string
  ): Promise<BranchInfo | null> {
    const conversation = await this.dependencies.conversationService.getConversation(conversationId);
    if (!conversation) {
      return null;
    }

    return this.findBranchInConversation(conversation, branchId);
  }

  /**
   * Update branch metadata
   */
  async updateBranchMetadata(
    conversationId: string,
    branchId: string,
    metadata: Partial<SubagentBranchMetadata>
  ): Promise<void> {
    const conversation = await this.dependencies.conversationService.getConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const branchInfo = this.findBranchInConversation(conversation, branchId);
    if (!branchInfo) {
      throw new Error(`Branch not found: ${branchId}`);
    }

    branchInfo.branch.metadata = {
      ...branchInfo.branch.metadata,
      ...metadata,
    } as SubagentBranchMetadata;
    branchInfo.branch.updated = Date.now();

    await this.dependencies.conversationService.updateConversation(conversationId, {
      messages: conversation.messages,
    });
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
    const conversation = await this.dependencies.conversationService.getConversation(conversationId);
    if (!conversation) {
      return [];
    }

    const results: BranchInfo[] = [];

    conversation.messages.forEach((message, index) => {
      if (message.branches) {
        for (const branch of message.branches) {
          results.push({
            branch,
            parentMessageId: message.id,
            parentMessageIndex: index,
          });
        }
      }
    });

    return results;
  }

  /**
   * Get all subagent branches (for UI status display)
   */
  async getSubagentBranches(conversationId: string): Promise<BranchInfo[]> {
    const allBranches = await this.getAllBranches(conversationId);
    return allBranches.filter(b => b.branch.type === 'subagent');
  }

  /**
   * Find a branch within a conversation (internal helper)
   */
  private findBranchInConversation(
    conversation: Conversation,
    branchId: string
  ): BranchInfo | null {
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
