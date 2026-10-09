import type { ConversationData, ConversationMessage } from '../../types/chat/ChatTypes';
import { ContextBudgetService } from './ContextBudgetService';
import {
  ContextCompactionService,
  type CompactedContext
} from './ContextCompactionService';

export interface HandoffModelConfig {
  providerId: string;
  modelId: string;
  contextWindow?: number | null;
}

export interface HandoffSummaryOptions {
  provider: string;
  model: string;
  maxTokens: number;
  signal?: AbortSignal;
  priorSummary?: string;
  sourceContextWindow?: number;
}

export interface HandoffPreparationInput {
  conversation: ConversationData;
  source: HandoffModelConfig;
  destination: HandoffModelConfig;
  systemPrompt: string;
  /** Estimated destination tool schema overhead. */
  toolTokens?: number;
  /** Space reserved for the next model answer. */
  outputHeadroomTokens?: number;
  signal?: AbortSignal;
  summarizer: (messages: ConversationMessage[], options: HandoffSummaryOptions) => Promise<string>;
}

/** Builds a candidate frontier; persistence and model selection belong to the caller. */
export class ContextHandoffService {
  async prepare(input: HandoffPreparationInput): Promise<CompactedContext | undefined> {
    const { conversation, source, destination, signal } = input;
    this.assertNotAborted(signal);
    const policy = ContextBudgetService.getPolicy(destination.providerId, destination.contextWindow);
    if (!policy) throw new Error('Destination context window is unknown');
    const sourcePolicy = ContextBudgetService.getPolicy(source.providerId, source.contextWindow);
    if (!sourcePolicy) throw new Error('Source context window is unknown');

    const active = ContextCompactionService.getMessagesAfterBoundary(conversation.messages, conversation.metadata);
    const compaction = conversation.metadata?.compaction as {
      frontier?: Array<{ summary?: string; boundaryMessageId?: string; boundaryMode?: 'at' | 'after' }>;
      previousContext?: { summary?: string; boundaryMessageId?: string; boundaryMode?: 'at' | 'after' };
    } | undefined;
    const frontier = compaction?.frontier ?? (compaction?.previousContext ? [compaction.previousContext] : []);
    const priorSummary = frontier.map(record => record.summary).filter((value): value is string => !!value).join('\n\n');
    const reserve = Math.max(input.outputHeadroomTokens ?? Math.ceil(policy.maxTokens * 0.1), 1024);
    const fixed = ContextBudgetService.estimateTextTokens(input.systemPrompt)
      + Math.max(0, input.toolTokens ?? 0) + reserve + 512;
    const available = policy.maxTokens - fixed;
    if (available <= 0) throw new Error('Destination system prompt, tools and output reserve exceed its context window');

    const activeTokens = active.reduce((sum, message) => sum + ContextBudgetService.estimateMessageTokens(message), 0);
    const priorTokens = ContextBudgetService.estimateTextTokens(priorSummary);
    const usageBasedTokens = Math.max(0,
      ContextBudgetService.estimateConversationTokens(conversation, input.systemPrompt)
      - ContextBudgetService.estimateTextTokens(input.systemPrompt));
    const occupied = Math.max(activeTokens + priorTokens, usageBasedTokens);
    if (occupied <= available) return undefined;
    const estimationScale = occupied / Math.max(1, activeTokens + priorTokens);

    // An exchange starts with a user message and includes its assistant/tool replies.
    // This prevents keeping a tool result without the call and request that produced it.
    const groups: ConversationMessage[][] = [];
    for (const message of active) {
      if (message.role === 'user' || groups.length === 0) groups.push([]);
      groups[groups.length - 1].push(message);
    }
    const summaryLimit = Math.min(12_000, Math.max(256, Math.floor(available * 0.3)),
      Math.max(128, Math.floor(sourcePolicy.maxTokens * 0.2)));
    const kept: ConversationMessage[][] = [];
    let keptTokens = 0;
    for (let index = groups.length - 1; index >= 0; index--) {
      const groupTokens = groups[index].reduce((sum, message) => sum + ContextBudgetService.estimateMessageTokens(message), 0) * estimationScale;
      if (keptTokens + groupTokens + summaryLimit > available) break;
      kept.unshift(groups[index]);
      keptTokens += groupTokens;
    }
    const removed = groups.slice(0, groups.length - kept.length).flat();
    if (removed.length === 0 && !priorSummary) return undefined;
    const maxSummaryTokens = Math.min(summaryLimit, available - keptTokens);
    if (maxSummaryTokens < 64) throw new Error('No room for a safe handoff summary');
    // The source model writes the summary. No state-saving tool or transcript mutation
    // occurs during preparation; failure leaves the selected model untouched.
    const summary = await input.summarizer(removed, {
      provider: source.providerId,
      model: source.modelId,
      maxTokens: maxSummaryTokens,
      signal,
      priorSummary: priorSummary || undefined,
      sourceContextWindow: sourcePolicy.maxTokens
    });
    this.assertNotAborted(signal);
    if (!summary?.trim() || ContextBudgetService.estimateTextTokens(summary) > maxSummaryTokens) {
      throw new Error('Handoff summary is empty or exceeds the destination budget');
    }
    const keptMessages = kept.flat();
    return {
      summary: summary.trim(),
      messagesRemoved: removed.length,
      messagesKept: keptMessages.length,
      filesReferenced: [],
      topics: [],
      compactedAt: Date.now(),
      boundaryMessageId: keptMessages[0]?.id ?? active[active.length - 1]?.id ?? frontier[frontier.length - 1]?.boundaryMessageId,
      boundaryMode: keptMessages.length ? 'at' : active.length ? 'after' : frontier[frontier.length - 1]?.boundaryMode
    };
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('Context handoff cancelled');
  }
}
