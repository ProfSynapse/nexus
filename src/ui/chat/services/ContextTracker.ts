/**
 * ContextTracker - Handles context usage and cost tracking
 * Location: /src/ui/chat/services/ContextTracker.ts
 *
 * Provides context window usage calculations and conversation cost tracking.
 * Delegates token calculation to TokenCalculator utility.
 */

import { ConversationData } from '../../../types/chat/ChatTypes';
import { ModelOption } from '../types/SelectionTypes';
import { ContextUsage } from '../components/ContextProgressBar';
import { TokenCalculator } from '../utils/TokenCalculator';
import type { ModelAgentManager } from './ModelAgentManager';
import type { ConversationManager } from './ConversationManager';

export class ContextTracker {
  constructor(
    private conversationManager: ConversationManager,
    private modelAgentManager: ModelAgentManager
  ) {}

  /**
   * Get current context usage for the active conversation
   * Calculates tokens used vs total context window
   */
  async getContextUsage(): Promise<ContextUsage> {
    const conversation = this.conversationManager.getCurrentConversation();
    const selectedModel = await this.modelAgentManager.getSelectedModelOrDefault();

    const usage = await TokenCalculator.getContextUsage(
      selectedModel,
      conversation,
      await this.modelAgentManager.getCurrentSystemPrompt()
    );
    return usage;
  }

  /**
   * Get conversation cost tracking
   * Returns total cost and currency from conversation metadata
   */
  getConversationCost(): { totalCost: number; currency: string } | null {
    const conversation = this.conversationManager.getCurrentConversation();
    if (!conversation) return null;

    // Prefer structured cost field if present
    if (conversation.cost?.totalCost !== undefined) {
      return {
        totalCost: conversation.cost.totalCost,
        currency: conversation.cost.currency || 'USD'
      };
    }

    // Fallback to metadata (legacy)
    if (conversation.metadata?.cost?.totalCost !== undefined) {
      return {
        totalCost: conversation.metadata.cost.totalCost,
        currency: conversation.metadata.cost.currency || 'USD'
      };
    }

    if (conversation.metadata?.totalCost !== undefined) {
      return {
        totalCost: conversation.metadata.totalCost,
        currency: conversation.metadata.currency || 'USD'
      };
    }

    return null;
  }
}
