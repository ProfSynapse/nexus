/**
 * BranchMigrationService - Migrate alternatives[] to branches[] structure
 *
 * Handles migration from the old message alternatives system to the new
 * unified branch model. This is applied when loading conversations from
 * JSON files.
 *
 * Old structure:
 *   message.alternatives: ChatMessage[]
 *   message.activeAlternativeIndex: number (0 = original, 1+ = alternative index + 1)
 *
 * New structure:
 *   message.branches: ConversationBranch[]
 *   Each branch has type='human', inheritContext=true
 */

import type { Conversation, ChatMessage } from '../../types/chat/ChatTypes';
import type { ConversationBranch, HumanBranchMetadata } from '../../types/branch/BranchTypes';

/**
 * Legacy message structure with alternatives
 * This represents what might be in old JSON files
 */
interface LegacyMessage extends ChatMessage {
  alternatives?: LegacyAlternativeMessage[];
  activeAlternativeIndex?: number;
}

/**
 * Legacy alternative message structure
 */
interface LegacyAlternativeMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  conversationId?: string;
  toolCalls?: any[];
  reasoning?: string;
  metadata?: Record<string, any>;
}

/**
 * Legacy conversation that may have alternatives
 */
interface LegacyConversation extends Omit<Conversation, 'messages'> {
  messages: LegacyMessage[];
}

export interface MigrationResult {
  migrated: boolean;
  messagesUpdated: number;
  branchesCreated: number;
}

export class BranchMigrationService {
  /**
   * Migrate a conversation from alternatives to branches structure
   * This is safe to call multiple times - it only migrates if needed
   */
  migrateConversation(conversation: LegacyConversation): MigrationResult {
    const result: MigrationResult = {
      migrated: false,
      messagesUpdated: 0,
      branchesCreated: 0,
    };

    for (const message of conversation.messages) {
      if (this.needsMigration(message)) {
        this.migrateMessage(message);
        result.messagesUpdated++;
        result.branchesCreated += message.branches?.length || 0;
        result.migrated = true;
      }
    }

    return result;
  }

  /**
   * Check if a message needs migration
   * Returns true if it has alternatives[] but no branches[]
   */
  private needsMigration(message: LegacyMessage): boolean {
    // Has old alternatives array
    if (message.alternatives && message.alternatives.length > 0) {
      // But doesn't have new branches array (or it's empty)
      if (!message.branches || message.branches.length === 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Migrate a single message from alternatives to branches
   */
  private migrateMessage(message: LegacyMessage): void {
    if (!message.alternatives || message.alternatives.length === 0) {
      return;
    }

    // Initialize branches array
    message.branches = [];

    // Convert each alternative to a human branch
    for (let i = 0; i < message.alternatives.length; i++) {
      const alternative = message.alternatives[i];
      const branch = this.createBranchFromAlternative(
        alternative,
        message.conversationId,
        i + 1 // 1-indexed to match activeAlternativeIndex convention
      );
      message.branches.push(branch);
    }

    // Clean up legacy fields after migration
    // We keep them for now to maintain backward compatibility during transition
    // They will be ignored by the new code
  }

  /**
   * Create a ConversationBranch from a legacy alternative message
   */
  private createBranchFromAlternative(
    alternative: LegacyAlternativeMessage,
    conversationId: string,
    index: number
  ): ConversationBranch {
    const now = Date.now();

    // Create the branch message from the alternative
    const branchMessage: ChatMessage = {
      id: alternative.id || `alt-${index}-${now}`,
      role: alternative.role,
      content: alternative.content,
      timestamp: alternative.timestamp || now,
      conversationId: conversationId,
      state: 'complete',
      toolCalls: alternative.toolCalls,
      reasoning: alternative.reasoning,
      metadata: alternative.metadata,
    };

    const metadata: HumanBranchMetadata = {
      description: `Alternative response ${index}`,
    };

    return {
      id: `migrated-alt-${index}-${alternative.id || now}`,
      type: 'human',
      inheritContext: true,
      messages: [branchMessage],
      created: alternative.timestamp || now,
      updated: alternative.timestamp || now,
      metadata,
    };
  }

  /**
   * Check if a conversation needs migration
   */
  conversationNeedsMigration(conversation: LegacyConversation): boolean {
    return conversation.messages.some((msg) => this.needsMigration(msg));
  }

  /**
   * Get migration statistics for a conversation without modifying it
   */
  getMigrationStats(conversation: LegacyConversation): {
    needsMigration: boolean;
    messagesWithAlternatives: number;
    totalAlternatives: number;
  } {
    let messagesWithAlternatives = 0;
    let totalAlternatives = 0;

    for (const message of conversation.messages) {
      if (this.needsMigration(message)) {
        messagesWithAlternatives++;
        totalAlternatives += message.alternatives?.length || 0;
      }
    }

    return {
      needsMigration: messagesWithAlternatives > 0,
      messagesWithAlternatives,
      totalAlternatives,
    };
  }
}

// Export singleton for convenience
export const branchMigrationService = new BranchMigrationService();
