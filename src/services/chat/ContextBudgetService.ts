import type { TokenUsage } from '../llm/adapters/types';
import { TokenUsageExtractor } from '../llm/utils/TokenUsageExtractor';
import { ConversationData, ConversationMessage } from '../../types/chat/ChatTypes';
import { ContextCompactionService } from './ContextCompactionService';

/**
 * Usage as persisted on a chat message: the adapter's TokenUsage carried whole,
 * cache read/write counts and any provider-reported price included.
 */
export type NormalizedTokenUsage = TokenUsage;

export interface ContextBudgetPolicy {
  maxTokens: number;
  warningThreshold: number;
  compactThreshold: number;
}

export interface ContextBudgetEstimate {
  policy: ContextBudgetPolicy | null;
  currentTokens: number;
  projectedTokens: number;
  projectedPercent: number;
  shouldWarn: boolean;
  shouldCompact: boolean;
}

const DEFAULT_THRESHOLDS = {
  warningThreshold: 0.75,
  compactThreshold: 0.9
} as const;

const PROVIDER_POLICIES: Record<string, ContextBudgetPolicy> = {
  webllm: {
    maxTokens: 4096,
    ...DEFAULT_THRESHOLDS
  },
  'anthropic-claude-code': {
    maxTokens: 200_000,
    ...DEFAULT_THRESHOLDS
  },
  'google-gemini-cli': {
    maxTokens: 200_000,
    ...DEFAULT_THRESHOLDS
  },
  'openai-codex': {
    maxTokens: 200_000,
    ...DEFAULT_THRESHOLDS
  },
  'github-copilot': {
    maxTokens: 200_000,
    ...DEFAULT_THRESHOLDS
  }
};

export class ContextBudgetService {
  static getPolicy(providerId?: string | null, modelContextWindow?: number | null): ContextBudgetPolicy | null {
    if (!providerId) {
      return null;
    }

    if (typeof modelContextWindow === 'number' && Number.isFinite(modelContextWindow) && modelContextWindow > 0) {
      return { maxTokens: modelContextWindow, ...DEFAULT_THRESHOLDS };
    }

    return PROVIDER_POLICIES[providerId] || null;
  }

  static normalizeUsage(usage: unknown): NormalizedTokenUsage | null {
    if (!usage || typeof usage !== 'object') {
      return null;
    }

    const usageRecord = usage as Record<string, unknown>;
    const tokenContainer = this.extractTokenContainer(usageRecord);

    const promptTokens = this.readNumber(tokenContainer, [
      'promptTokens',
      'prompt_tokens',
      'inputTokens',
      'input_tokens',
      'prompt'
    ]) || 0;

    const completionTokens = this.readNumber(tokenContainer, [
      'completionTokens',
      'completion_tokens',
      'outputTokens',
      'output_tokens',
      'candidatesTokens',
      'candidates_tokens',
      'completion',
      'candidates'
    ]) || 0;

    const totalTokens = this.readNumber(tokenContainer, [
      'totalTokens',
      'total_tokens',
      'total'
    ]) || (promptTokens + completionTokens);

    if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
      return null;
    }

    const normalized: NormalizedTokenUsage = {
      promptTokens,
      completionTokens,
      totalTokens
    };

    // Carry the optional classes through untouched — the adapter normalizer
    // already put them in camelCase. Dropping them here is how cache reads used
    // to vanish before cost was computed.
    const extra = TokenUsageExtractor.normalize(tokenContainer);
    if (extra?.cacheReadTokens) {
      normalized.cacheReadTokens = extra.cacheReadTokens;
      normalized.cachedTokens = extra.cacheReadTokens;
    }
    if (extra?.cacheWriteTokens) normalized.cacheWriteTokens = extra.cacheWriteTokens;
    if (extra?.reasoningTokens) normalized.reasoningTokens = extra.reasoningTokens;
    if (extra?.audioTokens) normalized.audioTokens = extra.audioTokens;
    if (extra?.providerCost) normalized.providerCost = extra.providerCost;
    if (extra?.webSearchRequests !== undefined) normalized.webSearchRequests = extra.webSearchRequests;
    if (extra?.webSearchCost !== undefined) normalized.webSearchCost = extra.webSearchCost;

    return normalized;
  }

  static estimateTextTokens(text: string | null | undefined): number {
    if (!text) {
      return 0;
    }

    return Math.ceil(text.length / 4);
  }

  /** Estimate the full serialized message, including tool requests and outcomes. */
  static estimateMessageTokens(message: ConversationMessage): number {
    let tokens = this.estimateTextTokens(message.content) + 8;
    for (const call of message.toolCalls ?? []) {
      tokens += this.estimateTextTokens(call.function?.name);
      tokens += this.estimateTextTokens(call.function?.arguments);
      if (call.parameters) tokens += this.estimateTextTokens(JSON.stringify(call.parameters));
      if (call.result !== undefined) {
        tokens += this.estimateTextTokens(typeof call.result === 'string' ? call.result : JSON.stringify(call.result));
      }
    }
    return tokens;
  }

  static estimateConversationTokens(
    conversation: ConversationData,
    systemPrompt?: string | null
  ): number {
    // Respect compaction boundary: only count messages that will be sent to the LLM.
    // Messages before the boundary are summarized in the compaction frontier (system prompt).
    const messages = this.getMessagesAfterCompactionBoundary(conversation);
    const compaction = conversation.metadata?.compaction as { frontier?: Array<{ compactedAt?: number }> } | undefined;
    const latestCompactedAt = compaction?.frontier?.[compaction.frontier.length - 1]?.compactedAt;
    // The latest provider response reports the prompt it actually received,
    // including prior messages and system prompt. Earlier response usage is
    // billing history, so summing it again inflates current context occupancy.
    let anchorIndex = -1;
    let totalTokens = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== 'assistant'
        || (typeof latestCompactedAt === 'number' && message.timestamp <= latestCompactedAt)) continue;
      const usage = this.normalizeUsage(message.metadata?.latestResponseUsage
        ?? (message.metadata?.billingUsageAggregated ? undefined : message.usage));
      if (usage) {
        anchorIndex = index;
        totalTokens = usage.totalTokens;
        break;
      }
    }
    if (anchorIndex < 0) totalTokens = this.estimateTextTokens(systemPrompt);

    for (const message of messages.slice(anchorIndex + 1)) {
      totalTokens += this.estimateTextTokens(message.content);

      if (message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          if (toolCall.parameters) {
            totalTokens += this.estimateTextTokens(JSON.stringify(toolCall.parameters));
          }

          if (toolCall.result) {
            const resultText = typeof toolCall.result === 'string'
              ? toolCall.result
              : JSON.stringify(toolCall.result);
            totalTokens += this.estimateTextTokens(resultText);
          }
        }
      }
    }

    return totalTokens;
  }

  static estimateBudget(
    providerId: string | null | undefined,
    conversation: ConversationData,
    systemPrompt?: string | null,
    newMessage?: string,
    modelContextWindow?: number | null
  ): ContextBudgetEstimate {
    const policy = this.getPolicy(providerId, modelContextWindow);
    const currentTokens = this.estimateConversationTokens(conversation, systemPrompt);
    const projectedTokens = currentTokens + this.estimateTextTokens(newMessage);

    if (!policy) {
      return {
        policy: null,
        currentTokens,
        projectedTokens,
        projectedPercent: 0,
        shouldWarn: false,
        shouldCompact: false
      };
    }

    const projectedPercent = projectedTokens / policy.maxTokens;

    return {
      policy,
      currentTokens,
      projectedTokens,
      projectedPercent,
      shouldWarn: projectedPercent >= policy.warningThreshold,
      shouldCompact: projectedPercent >= policy.compactThreshold
    };
  }

  private static extractTokenContainer(usageRecord: Record<string, unknown>): Record<string, unknown> {
    const tokens = usageRecord.tokens;
    if (tokens && typeof tokens === 'object' && !Array.isArray(tokens)) {
      return tokens as Record<string, unknown>;
    }

    return usageRecord;
  }

  private static readNumber(
    record: Record<string, unknown>,
    keys: string[]
  ): number | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }

    return undefined;
  }

  /**
   * Return only messages after the latest compaction boundary.
   * If no boundary exists, returns all messages.
   */
  private static getMessagesAfterCompactionBoundary(conversation: ConversationData): ConversationData['messages'] {
    return ContextCompactionService.getMessagesAfterBoundary(
      conversation.messages,
      conversation.metadata
    );
  }
}
