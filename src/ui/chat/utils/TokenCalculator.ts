/**
 * TokenCalculator - Handles token counting and context usage calculations
 */

import { ConversationData } from '../../../types/chat/ChatTypes';
import { ModelOption } from '../types/SelectionTypes';
import { ContextUsage } from '../components/ContextProgressBar';

export class TokenCalculator {
  /**
   * Get current context usage for a conversation and model
   */
  static async getContextUsage(
    selectedModel: ModelOption | null,
    currentConversation: ConversationData | null,
    currentSystemPrompt: string | null
  ): Promise<ContextUsage> {
    try {
      if (!selectedModel || !currentConversation) {
        return { used: 0, total: 0, percentage: 0 };
      }

      // Estimate token count for current conversation
      const totalTokens = this.estimateTokenCount(currentConversation, currentSystemPrompt);
      const contextWindow = selectedModel.contextWindow;
      const percentage = (totalTokens / contextWindow) * 100;

      return {
        used: totalTokens,
        total: contextWindow,
        percentage: Math.min(percentage, 100)
      };
    } catch (error) {
      console.error('[TokenCalculator] Error calculating context usage:', error);
      return { used: 0, total: 0, percentage: 0 };
    }
  }

  /**
   * Estimate token count for a conversation
   */
  static estimateTokenCount(
    conversation: ConversationData,
    currentSystemPrompt?: string | null
  ): number {
    let totalTokens = 0;
    let hasActualUsageData = false;

    // Add system prompt tokens if provided (always estimated)
    if (currentSystemPrompt) {
      const systemPromptTokens = this.estimateTextTokens(currentSystemPrompt);
      totalTokens += systemPromptTokens;
    }

    // Add message tokens - USE ACTUAL USAGE DATA when available
    conversation.messages.forEach((message: any, index) => {
      // Check if message has actual usage data from API response
      if (message.usage) {
        hasActualUsageData = true;
        // Use actual token counts from OpenAI/Anthropic/etc API
        const promptTokens = message.usage.prompt_tokens || message.usage.input_tokens || 0;
        const completionTokens = message.usage.completion_tokens || message.usage.output_tokens || 0;
        const totalMessageTokens = message.usage.total_tokens || (promptTokens + completionTokens);

        totalTokens += totalMessageTokens;
      } else {
        // Fallback to estimation if no usage data
        const messageTokens = this.estimateTextTokens(message.content);
        totalTokens += messageTokens;

        // Add tokens for tool calls if present (estimated)
        if (message.toolCalls) {
          message.toolCalls.forEach((toolCall: { function?: { name?: string; arguments?: string }; parameters?: unknown; result?: unknown }) => {
            if (toolCall.parameters) {
              const paramTokens = this.estimateTextTokens(JSON.stringify(toolCall.parameters));
              totalTokens += paramTokens;
            }
            if (toolCall.result) {
              const resultText = typeof toolCall.result === 'string'
                ? toolCall.result
                : JSON.stringify(toolCall.result);
              const resultTokens = this.estimateTextTokens(resultText);
              totalTokens += resultTokens;
            }
          });
        }
      }
    });
    return totalTokens;
  }

  /**
   * Rough estimation of token count for text (4 chars ≈ 1 token)
   */
  static estimateTextTokens(text: string | null | undefined): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Check if conversation is approaching context limits
   */
  static getContextWarningLevel(percentage: number): 'safe' | 'moderate' | 'warning' | 'critical' {
    if (percentage < 50) return 'safe';
    if (percentage < 70) return 'moderate';
    if (percentage < 85) return 'warning';
    return 'critical';
  }

  /**
   * Get warning message for context usage
   */
  static getContextWarningMessage(percentage: number): string | null {
    const level = this.getContextWarningLevel(percentage);
    
    switch (level) {
      case 'warning':
        return 'Context approaching limit. Consider starting a new conversation.';
      case 'critical':
        return 'Context limit nearly reached. Responses may be truncated.';
      default:
        return null;
    }
  }

  /**
   * Estimate tokens for a single message before sending
   */
  static estimateMessageTokens(
    message: string,
    systemPrompt?: string | null
  ): number {
    let tokens = this.estimateTextTokens(message);
    
    if (systemPrompt) {
      tokens += this.estimateTextTokens(systemPrompt);
    }
    
    return tokens;
  }

  /**
   * Check if a new message would exceed context limits
   */
  static wouldExceedContextLimit(
    currentUsage: ContextUsage,
    newMessage: string,
    systemPrompt?: string | null,
    bufferPercentage: number = 10 // Leave 10% buffer
  ): boolean {
    const newMessageTokens = this.estimateMessageTokens(newMessage, systemPrompt);
    const projectedUsage = currentUsage.used + newMessageTokens;
    const maxAllowed = currentUsage.total * (100 - bufferPercentage) / 100;
    
    return projectedUsage > maxAllowed;
  }
}
