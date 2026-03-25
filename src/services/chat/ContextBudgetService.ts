import { ConversationData } from '../../types/chat/ChatTypes';

export interface NormalizedTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

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
  static getPolicy(providerId?: string | null): ContextBudgetPolicy | null {
    if (!providerId) {
      return null;
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

    return {
      promptTokens,
      completionTokens,
      totalTokens
    };
  }

  static estimateTextTokens(text: string | null | undefined): number {
    if (!text) {
      return 0;
    }

    return Math.ceil(text.length / 4);
  }

  static estimateConversationTokens(
    conversation: ConversationData,
    systemPrompt?: string | null
  ): number {
    let totalTokens = this.estimateTextTokens(systemPrompt);

    for (const message of conversation.messages) {
      const normalizedUsage = this.normalizeUsage((message as { usage?: unknown }).usage);

      if (normalizedUsage) {
        totalTokens += normalizedUsage.totalTokens;
        continue;
      }

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
    newMessage?: string
  ): ContextBudgetEstimate {
    const policy = this.getPolicy(providerId);
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
}
