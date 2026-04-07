import { ContextBudgetService } from '../../../services/chat/ContextBudgetService';
import type { CompactedContext } from '../../../services/chat/ContextCompactionService';
import {
  CompactionFrontierBudgetPolicy,
  CompactionFrontierRecord,
  CompactionFrontierService
} from '../../../services/chat/CompactionFrontierService';
import { ContextStatus, ContextTokenTracker } from '../../../services/chat/ContextTokenTracker';
import type { ConversationData } from '../../../types/chat/ChatTypes';
import type { ConversationMetadataWithCompaction } from './ModelAgentConversationSettingsStore';

const LOCAL_PROVIDER_CONTEXT_WINDOWS: Record<string, number> = {
  webllm: 4096,
  'anthropic-claude-code': 200000,
  'google-gemini-cli': 200000,
  'openai-codex': 200000,
  'github-copilot': 200000,
};

const PRE_SEND_ESTIMATE_MULTIPLIERS: Record<string, number> = {
  'anthropic-claude-code': 1.15,
  'google-gemini-cli': 1.15,
  'openai-codex': 1.15,
  'github-copilot': 1.15
};

export class ModelAgentCompactionState {
  private contextTokenTracker: ContextTokenTracker | null = null;
  private compactionFrontier: CompactionFrontierRecord[] = [];
  private compactionFrontierService = new CompactionFrontierService();

  recordTokenUsage(promptTokens: number, completionTokens: number): void {
    this.contextTokenTracker?.recordUsage(promptTokens, completionTokens);
  }

  getContextStatus(): ContextStatus | null {
    return this.contextTokenTracker?.getStatus() || null;
  }

  shouldCompactBeforeSending(
    conversationOrMessage: ConversationData | string,
    message: string | undefined,
    systemPrompt: string | null | undefined,
    providerOverride: string | null
  ): boolean {
    const messageText = typeof conversationOrMessage === 'string'
      ? conversationOrMessage
      : (message || '');

    if (this.contextTokenTracker) {
      return this.contextTokenTracker.shouldCompactBeforeSending(messageText);
    }

    if (typeof conversationOrMessage === 'string') {
      return false;
    }

    const budget = ContextBudgetService.estimateBudget(
      providerOverride,
      conversationOrMessage,
      systemPrompt,
      messageText
    );

    return budget.shouldCompact;
  }

  resetTokenTracker(): void {
    this.contextTokenTracker?.reset();
  }

  isUsingLocalModel(): boolean {
    return this.contextTokenTracker !== null;
  }

  getContextTokenTracker(): ContextTokenTracker | null {
    return this.contextTokenTracker;
  }

  appendCompactionRecord(context: CompactedContext): void {
    this.compactionFrontier = this.compactionFrontierService.appendRecord(this.compactionFrontier, context);
  }

  updatePolicy(modelContextWindow: number | undefined): void {
    const policy = CompactionFrontierService.createPolicyForContextWindow(modelContextWindow);
    this.compactionFrontierService = new CompactionFrontierService(policy);
    this.compactionFrontier = this.compactionFrontierService.normalizeFrontier(this.compactionFrontier);
  }

  updateContextTokenTracker(provider: string): void {
    const contextWindow = LOCAL_PROVIDER_CONTEXT_WINDOWS[provider];
    const preSendEstimateMultiplier = PRE_SEND_ESTIMATE_MULTIPLIERS[provider] ?? 1;

    if (contextWindow) {
      if (!this.contextTokenTracker) {
        this.contextTokenTracker = new ContextTokenTracker(contextWindow, preSendEstimateMultiplier);
      } else {
        this.contextTokenTracker.setMaxTokens(contextWindow);
        this.contextTokenTracker.setPreSendEstimateMultiplier(preSendEstimateMultiplier);
        this.contextTokenTracker.reset();
      }
    } else {
      this.contextTokenTracker = null;
    }
  }

  getCompactionFrontierBudgetPolicy(modelContextWindow: number | undefined): CompactionFrontierBudgetPolicy {
    return CompactionFrontierService.createPolicyForContextWindow(modelContextWindow);
  }

  buildMetadataWithCompactionRecord(
    metadata: Record<string, unknown> | undefined,
    compactionRecord: CompactedContext
  ): Record<string, unknown> {
    const frontier = this.compactionFrontierService.appendRecord(
      this.getFrontierFromMetadata((metadata ?? {}) as ConversationMetadataWithCompaction),
      compactionRecord
    );
    return this.buildMetadataWithCompactionFrontier(metadata, frontier);
  }

  buildMetadataWithCompactionFrontier(
    metadata: Record<string, unknown> | undefined,
    frontier: CompactedContext[]
  ): Record<string, unknown> {
    const existingMetadata = (metadata ?? {}) as ConversationMetadataWithCompaction;
    const existingCompaction = existingMetadata.compaction ?? {};
    const { previousContext: _legacyPreviousContext, ...remainingCompaction } = existingCompaction;
    void _legacyPreviousContext;
    const normalizedFrontier = this.compactionFrontierService.normalizeFrontier(frontier);

    return {
      ...existingMetadata,
      compaction: {
        ...remainingCompaction,
        frontier: normalizedFrontier
      }
    };
  }

  getLatestCompactionRecord(): CompactedContext | null {
    return this.compactionFrontier.length > 0
      ? this.compactionFrontier[this.compactionFrontier.length - 1]
      : null;
  }

  getCompactionFrontier(): CompactionFrontierRecord[] {
    return [...this.compactionFrontier];
  }

  clearCompactionFrontier(): void {
    this.compactionFrontier = [];
  }

  hasCompactionFrontier(): boolean {
    return this.compactionFrontier.some(record => record.summary.length > 0);
  }

  restoreCompactionFrontierFromMetadata(
    metadata: ConversationMetadataWithCompaction | undefined
  ): void {
    this.compactionFrontier = this.getFrontierFromMetadata(metadata);
  }

  private getFrontierFromMetadata(
    metadata: ConversationMetadataWithCompaction | undefined
  ): CompactionFrontierRecord[] {
    const frontier = metadata?.compaction?.frontier;
    if (Array.isArray(frontier)) {
      return this.compactionFrontierService.normalizeFrontier(
        frontier.filter(this.isValidCompactedContext)
      );
    }

    const legacyCompactionRecord = metadata?.compaction?.previousContext;
    if (this.isValidCompactedContext(legacyCompactionRecord)) {
      return this.compactionFrontierService.normalizeFrontier([legacyCompactionRecord]);
    }

    return [];
  }

  private isValidCompactedContext = (value: unknown): value is CompactedContext => {
    return !!value &&
      typeof value === 'object' &&
      typeof (value as CompactedContext).summary === 'string' &&
      (value as CompactedContext).summary.length > 0;
  };
}
