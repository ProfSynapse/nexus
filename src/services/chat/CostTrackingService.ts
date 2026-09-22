/**
 * CostTrackingService - Manages usage tracking and cost calculation for chat messages
 *
 * Responsibilities:
 * - Track token usage from LLM responses
 * - Calculate costs from usage data
 * - Persist usage and cost to messages
 * - Update conversation-level cost aggregation
 * - Handle async usage updates (OpenRouter streaming)
 * - Prevent double-counting of costs
 *
 * Follows Single Responsibility Principle - only handles cost tracking.
 */

import { CostCalculator } from '../llm/adapters/CostCalculator';
import { TokenUsageExtractor } from '../llm/utils/TokenUsageExtractor';
import type { TokenUsage } from '../llm/adapters/types';
import type { ConversationData, ChatMessage } from '../../types/chat/ChatTypes';

export type UsageData = TokenUsage & {
  source?: string;
};

export interface CostData {
  totalCost: number;
  currency: string;
}


/** Conversation service interface for cost tracking */
interface ConversationServiceLike {
  getConversation: (id: string) => Promise<ConversationData | null>;
  updateConversation: (id: string, updates: Partial<ConversationData>) => Promise<void>;
}

export class CostTrackingService {
  constructor(
    private conversationService: ConversationServiceLike
  ) {}

  /**
   * Calculate cost from usage data
   */
  calculateCost(provider: string, model: string, usage: UsageData): CostData | null {
    const costBreakdown = CostCalculator.calculateCostFromUsage(provider, model, usage);

    if (!costBreakdown) {
      return null;
    }

    return {
      totalCost: costBreakdown.totalCost,
      currency: costBreakdown.currency
    };
  }

  /**
   * Update message with usage and cost data (async callback handler)
   * Used for delayed usage updates from providers like OpenRouter
   */
  async updateMessageCost(
    conversationId: string,
    messageId: string,
    usage: UsageData,
    cost: CostData | null
  ): Promise<void> {
    try {
      // Load conversation, find message, update it, save back
      const conversation = await this.conversationService.getConversation(conversationId);
      if (!conversation) {
        console.error('[CostTrackingService] Conversation not found for async usage update');
        return;
      }

      // Find the message by ID
      const message = conversation.messages.find((m: ChatMessage) => m.id === messageId);
      if (!message) {
        console.error('[CostTrackingService] Message not found for async usage update:', messageId);
        return;
      }

      // Check if message already has cost (to prevent double-counting)
      const hadCost = !!message.cost;

      // Update message with usage and cost
      message.usage = usage;
      if (cost) {
        message.cost = cost;
      }

      // Save updated conversation
      await this.conversationService.updateConversation(conversation.id, { messages: conversation.messages });

      // Update conversation-level cost aggregation
      // Only add to conversation cost if we didn't already count this message
      if (!hadCost && cost) {
        await this.updateConversationCost(conversationId, cost);
      }

    } catch (error) {
      console.error('[CostTrackingService] Failed to update message with async usage:', error);
    }
  }

  /**
   * Update conversation-level cost aggregation
   */
  async updateConversationCost(conversationId: string, messageCost: CostData): Promise<void> {
    try {
      const conversation = await this.conversationService.getConversation(conversationId);
      if (!conversation) {
        console.error('[CostTrackingService] Conversation not found for cost update');
        return;
      }

      // Initialize conversation cost if not present
      if (!conversation.cost) {
        conversation.cost = {
          totalCost: 0,
          currency: messageCost.currency
        };
      }

      // Add message cost to conversation total
      conversation.cost.totalCost += messageCost.totalCost;

      // Save updated conversation (pass ID and updates separately)
      await this.conversationService.updateConversation(conversationId, { cost: conversation.cost });

    } catch (error) {
      console.error('[CostTrackingService] Failed to update conversation cost:', error);
    }
  }

  /**
   * Create async usage callback for streaming
   * Returns a callback function that can be passed to LLM streaming options
   */
  createUsageCallback(conversationId: string, messageId: string): (usage: UsageData, cost: CostData | null) => Promise<void> {
    return async (usage: UsageData, cost: CostData | null) => {
      await this.updateMessageCost(conversationId, messageId, usage, cost);
    };
  }

  /**
   * Track usage and cost for a message (synchronous, from final streaming chunk)
   */
  async trackMessageUsage(
    conversationId: string,
    messageId: string,
    provider: string,
    model: string,
    usage: UsageData
  ): Promise<CostData | null> {
    // Calculate cost from usage
    const cost = this.calculateCost(provider, model, usage);

    if (!cost) {
      return null;
    }

    // Update conversation-level cost
    await this.updateConversationCost(conversationId, cost);

    return cost;
  }

  /**
   * Extract usage data from streaming chunk or final usage object
   */
  extractUsage(usageObject: unknown): UsageData | null {
    const usage = TokenUsageExtractor.normalize(usageObject);
    if (!usage || (usage.promptTokens === 0 && usage.completionTokens === 0)) {
      return null;
    }

    return { ...usage, source: 'provider_api' };
  }
}
