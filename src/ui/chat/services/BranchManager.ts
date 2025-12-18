/**
 * BranchManager - Handles message-level branching operations
 *
 * Manages creating and switching between branches for individual messages.
 * Works with the unified branch model where both human alternatives and
 * subagent branches share the same data structure.
 *
 * Human branches: inheritContext=true (includes parent context)
 * Subagent branches: inheritContext=false (fresh start)
 */

// import { ConversationRepository } from '../../../database/services/chat/ConversationRepository';
type ConversationRepository = any;
import { ConversationData, ConversationMessage } from '../../../types/chat/ChatTypes';
import type { ConversationBranch, HumanBranchMetadata } from '../../../types/branch/BranchTypes';

export interface BranchManagerEvents {
  onBranchCreated: (messageId: string, branchId: string) => void;
  onBranchSwitched: (messageId: string, branchId: string) => void;
  onError: (message: string) => void;
}

export class BranchManager {
  constructor(
    private conversationRepo: ConversationRepository,
    private events: BranchManagerEvents
  ) {}

  /**
   * Create a human branch (alternative response) for a specific message
   */
  async createHumanBranch(
    conversation: ConversationData,
    messageId: string,
    alternativeResponse: ConversationMessage,
    description?: string
  ): Promise<string | null> {
    try {
      // Find the message in the conversation
      const messageIndex = conversation.messages.findIndex((msg) => msg.id === messageId);
      if (messageIndex === -1) {
        console.error('[BranchManager] Message not found:', messageId);
        return null;
      }

      const message = conversation.messages[messageIndex];

      // Initialize branches array if it doesn't exist
      if (!message.branches) {
        message.branches = [];
      }

      // Create the new branch
      const now = Date.now();
      const branchId = `branch-${now}-${Math.random().toString(36).substring(2, 9)}`;

      const metadata: HumanBranchMetadata = {
        description: description || `Alternative response ${message.branches.length + 1}`,
      };

      const newBranch: ConversationBranch = {
        id: branchId,
        type: 'human',
        inheritContext: true,
        messages: [alternativeResponse],
        created: now,
        updated: now,
        metadata,
      };

      // Add the new branch
      message.branches.push(newBranch);

      // Set the new branch as active
      message.activeAlternativeIndex = message.branches.length; // 1-based (0 = original)

      // Save the updated conversation to repository
      await this.conversationRepo.updateConversation(conversation.id, {
        messages: conversation.messages,
      });

      this.events.onBranchCreated(messageId, branchId);

      return branchId;
    } catch (error) {
      console.error('[BranchManager] Failed to create branch:', error);
      this.events.onError('Failed to create alternative response');
      return null;
    }
  }

  /**
   * Switch to a specific branch by ID
   */
  async switchToBranch(
    conversation: ConversationData,
    messageId: string,
    branchId: string
  ): Promise<boolean> {
    try {
      // Find the message in the conversation
      const messageIndex = conversation.messages.findIndex((msg) => msg.id === messageId);
      if (messageIndex === -1) {
        console.error('[BranchManager] Message not found:', messageId);
        return false;
      }

      const message = conversation.messages[messageIndex];

      // Find the branch index
      if (!message.branches) {
        console.error('[BranchManager] No branches on message:', messageId);
        return false;
      }

      const branchIndex = message.branches.findIndex((b) => b.id === branchId);
      if (branchIndex === -1) {
        console.error('[BranchManager] Branch not found:', branchId);
        return false;
      }

      // Update the active alternative index
      // activeAlternativeIndex: 0 = original, 1+ = branch index + 1
      message.activeAlternativeIndex = branchIndex + 1;

      // Save the updated conversation to repository
      await this.conversationRepo.updateConversation(conversation.id, {
        messages: conversation.messages,
      });

      this.events.onBranchSwitched(messageId, branchId);

      return true;
    } catch (error) {
      console.error('[BranchManager] Failed to switch branch:', error);
      this.events.onError('Failed to switch to branch');
      return false;
    }
  }

  /**
   * Switch to original message (no branch)
   */
  async switchToOriginal(
    conversation: ConversationData,
    messageId: string
  ): Promise<boolean> {
    try {
      const messageIndex = conversation.messages.findIndex((msg) => msg.id === messageId);
      if (messageIndex === -1) {
        return false;
      }

      const message = conversation.messages[messageIndex];
      message.activeAlternativeIndex = 0;

      await this.conversationRepo.updateConversation(conversation.id, {
        messages: conversation.messages,
      });

      this.events.onBranchSwitched(messageId, 'original');
      return true;
    } catch (error) {
      console.error('[BranchManager] Failed to switch to original:', error);
      return false;
    }
  }

  /**
   * Switch to a branch by index (0 = original, 1+ = branch index)
   */
  async switchToBranchByIndex(
    conversation: ConversationData,
    messageId: string,
    index: number
  ): Promise<boolean> {
    if (index === 0) {
      return this.switchToOriginal(conversation, messageId);
    }

    const message = conversation.messages.find((msg) => msg.id === messageId);
    if (!message?.branches) {
      return false;
    }

    const branchIndex = index - 1;
    if (branchIndex < 0 || branchIndex >= message.branches.length) {
      return false;
    }

    return this.switchToBranch(conversation, messageId, message.branches[branchIndex].id);
  }

  /**
   * Get the currently active branch for a message
   */
  getActiveBranch(message: ConversationMessage): ConversationBranch | null {
    const activeIndex = message.activeAlternativeIndex || 0;

    // Index 0 is the original message
    if (activeIndex === 0 || !message.branches) {
      return null;
    }

    const branchIndex = activeIndex - 1;
    if (branchIndex >= 0 && branchIndex < message.branches.length) {
      return message.branches[branchIndex];
    }

    return null;
  }

  /**
   * Get the currently active message content (original or from branch)
   */
  getActiveMessageContent(message: ConversationMessage): string {
    const branch = this.getActiveBranch(message);
    if (branch && branch.messages.length > 0) {
      // Return the last message content from the branch
      return branch.messages[branch.messages.length - 1].content;
    }
    return message.content;
  }

  /**
   * Get the currently active message tool calls
   */
  getActiveMessageToolCalls(message: ConversationMessage): any[] | undefined {
    const branch = this.getActiveBranch(message);
    if (branch && branch.messages.length > 0) {
      return branch.messages[branch.messages.length - 1].toolCalls;
    }
    return message.toolCalls;
  }

  /**
   * Get the currently active message reasoning
   */
  getActiveMessageReasoning(message: ConversationMessage): string | undefined {
    const branch = this.getActiveBranch(message);
    if (branch && branch.messages.length > 0) {
      return branch.messages[branch.messages.length - 1].reasoning;
    }
    return message.reasoning;
  }

  /**
   * Get branch navigation info for a message
   */
  getBranchInfo(message: ConversationMessage): {
    current: number;
    total: number;
    hasBranches: boolean;
    activeBranchId?: string;
    activeBranchType?: 'human' | 'subagent';
  } {
    const activeIndex = message.activeAlternativeIndex || 0;
    const branchCount = message.branches?.length || 0;
    const total = branchCount + 1; // +1 for original

    const branch = this.getActiveBranch(message);

    return {
      current: activeIndex + 1, // 1-based for display
      total,
      hasBranches: branchCount > 0,
      activeBranchId: branch?.id,
      activeBranchType: branch?.type,
    };
  }

  /**
   * Check if a message has any branches
   */
  hasBranches(message: ConversationMessage): boolean {
    return (message.branches?.length || 0) > 0;
  }

  /**
   * Get all branches for a message
   */
  getBranches(message: ConversationMessage): ConversationBranch[] {
    return message.branches || [];
  }

  /**
   * Get branch by ID from a message
   */
  getBranchById(message: ConversationMessage, branchId: string): ConversationBranch | null {
    if (!message.branches) {
      return null;
    }
    return message.branches.find((b) => b.id === branchId) || null;
  }

  /**
   * Check if any branch on a message is a subagent branch
   */
  hasSubagentBranches(message: ConversationMessage): boolean {
    if (!message.branches) {
      return false;
    }
    return message.branches.some((b) => b.type === 'subagent');
  }

  /**
   * Get only subagent branches for a message
   */
  getSubagentBranches(message: ConversationMessage): ConversationBranch[] {
    if (!message.branches) {
      return [];
    }
    return message.branches.filter((b) => b.type === 'subagent');
  }

  /**
   * Get only human branches for a message
   */
  getHumanBranches(message: ConversationMessage): ConversationBranch[] {
    if (!message.branches) {
      return [];
    }
    return message.branches.filter((b) => b.type === 'human');
  }

  /**
   * Navigate to previous branch/original
   */
  getPreviousIndex(message: ConversationMessage): number | null {
    const currentIndex = message.activeAlternativeIndex || 0;
    return currentIndex > 0 ? currentIndex - 1 : null;
  }

  /**
   * Navigate to next branch
   */
  getNextIndex(message: ConversationMessage): number | null {
    const currentIndex = message.activeAlternativeIndex || 0;
    const total = (message.branches?.length || 0) + 1;
    return currentIndex < total - 1 ? currentIndex + 1 : null;
  }
}
