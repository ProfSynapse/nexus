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

export interface UsageData {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source?: string;
}

export interface CostData {
  totalCost: number;
  currency: string;
}

export class CostTrackingService {
  constructor(
    private conversationService: any
  ) {}

  /**
   * Calculate cost from usage data
   */
  calculateCost(provider: string, model: string, usage: UsageData): CostData | null {
    const costBreakdown = CostCalculator.calculateCost(
      provider,
      model,
      {
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        source: (usage.source as 'provider_api' | 'fallback_tokenizer') || 'provider_api'
      }
    );

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
    usage: any,
    cost: any
  ): Promise<void> {
    try {
      // Load conversation, find message, update it, save back
      const conversation = await this.conversationService.getConversation(conversationId);
      if (!conversation) {
        console.error('[CostTrackingService] Conversation not found for async usage update');
        return;
      }

      // Find the message by ID
      const message = conversation.messages.find((m: any) => m.id === messageId);
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
  createUsageCallback(conversationId: string, messageId: string): (usage: any, cost: any) => Promise<void> {
    return async (usage: any, cost: any) => {
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
  extractUsage(usageObject: any): UsageData | null {
    if (!usageObject) return null;

    // Handle different usage formats
    const promptTokens = usageObject.promptTokens || usageObject.prompt_tokens || usageObject.inputTokens || 0;
    const completionTokens = usageObject.completionTokens || usageObject.completion_tokens || usageObject.outputTokens || 0;
    const totalTokens = usageObject.totalTokens || usageObject.total_tokens || (promptTokens + completionTokens);

    if (promptTokens === 0 && completionTokens === 0) {
      return null;
    }

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      source: 'provider_api'
    };
  }
}
