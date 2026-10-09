import { ContextBudgetService } from '../../src/services/chat/ContextBudgetService';
import { ConversationData } from '../../src/types/chat/ChatTypes';

type MessageWithUsage = ConversationData['messages'][number] & {
  usage?: unknown;
};

function createConversationWithContent(content: string, usage?: unknown): ConversationData {
  const message: MessageWithUsage = {
    id: 'msg_1',
    role: 'assistant',
    content,
    timestamp: Date.now(),
    conversationId: 'conv_1',
    usage
  };

  return {
    id: 'conv_1',
    title: 'Test',
    created: Date.now(),
    updated: Date.now(),
    messages: [message]
  };
}

describe('ContextBudgetService', () => {
  it('normalizes camelCase, snake_case, and nested token usage shapes', () => {
    expect(ContextBudgetService.normalizeUsage({
      promptTokens: 12,
      completionTokens: 7,
      totalTokens: 19
    })).toEqual({
      promptTokens: 12,
      completionTokens: 7,
      totalTokens: 19
    });

    expect(ContextBudgetService.normalizeUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15
    })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15
    });

    expect(ContextBudgetService.normalizeUsage({
      tokens: {
        prompt: 8,
        candidates: 3,
        total: 11
      }
    })).toEqual({
      promptTokens: 8,
      completionTokens: 3,
      totalTokens: 11
    });
  });

  it('treats zero-only usage as missing and falls back to estimation', () => {
    const conversation = createConversationWithContent('A'.repeat(80), {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    });

    expect(ContextBudgetService.estimateConversationTokens(conversation)).toBe(20);
  });

  it('applies the configured 200k soft cap providers to compaction decisions', () => {
    const conversation = createConversationWithContent('A'.repeat(725_000));
    const estimate = ContextBudgetService.estimateBudget(
      'anthropic-claude-code',
      conversation,
      null,
      'follow-up'
    );

    expect(estimate.policy?.maxTokens).toBe(200_000);
    expect(estimate.shouldCompact).toBe(true);
  });

  it('does not trigger compaction for providers without a policy', () => {
    const conversation = createConversationWithContent('A'.repeat(725_000));
    const estimate = ContextBudgetService.estimateBudget(
      'openai',
      conversation,
      null,
      'follow-up'
    );

    expect(estimate.policy).toBeNull();
    expect(estimate.shouldCompact).toBe(false);
  });

  it('uses a selected model limit instead of the provider fallback', () => {
    const conversation = createConversationWithContent('A'.repeat(725_000));
    const large = ContextBudgetService.estimateBudget('openai-codex', conversation, null, '', 1_050_000);
    const small = ContextBudgetService.estimateBudget('openai-codex', conversation, null, '', 128_000);

    expect(large.policy?.maxTokens).toBe(1_050_000);
    expect(large.shouldCompact).toBe(false);
    expect(small.policy?.maxTokens).toBe(128_000);
    expect(small.shouldCompact).toBe(true);
  });

  it('uses the latest provider response as context anchor rather than summing billing totals', () => {
    const conversation = createConversationWithContent('old answer', {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120
    });
    conversation.messages.push({
      id: 'msg_2', role: 'assistant', content: 'new answer',
      timestamp: Date.now(), conversationId: conversation.id,
      usage: { promptTokens: 400, completionTokens: 50, totalTokens: 450 },
      metadata: { latestResponseUsage: { promptTokens: 250, completionTokens: 30, totalTokens: 280 } }
    });
    conversation.messages.push({
      id: 'msg_3', role: 'user', content: 'follow-up',
      timestamp: Date.now(), conversationId: conversation.id
    });

    expect(ContextBudgetService.estimateConversationTokens(conversation, 'system prompt')).toBe(283);
  });

  it('does not reuse a pre-compaction response as an anchor for the new prompt', () => {
    const compactedAt = Date.now();
    const conversation = createConversationWithContent('retained answer', {
      promptTokens: 60_000, completionTokens: 1_000, totalTokens: 61_000
    });
    conversation.messages[0].timestamp = compactedAt - 100;
    conversation.metadata = { compaction: { frontier: [{ boundaryMessageId: 'msg_1', compactedAt }] } };
    conversation.messages.push({
      id: 'msg_2', role: 'user', content: 'new question',
      timestamp: compactedAt + 1, conversationId: conversation.id
    });

    expect(ContextBudgetService.estimateConversationTokens(conversation, 'new summary'))
      .toBe(Math.ceil('new summary'.length / 4) + Math.ceil('retained answer'.length / 4)
        + Math.ceil('new question'.length / 4));
  });

  it('estimates visible context instead of treating unordered fallback billing as occupancy', () => {
    const conversation = createConversationWithContent('actual answer', {
      promptTokens: 200_000, completionTokens: 1000, totalTokens: 201_000
    });
    conversation.messages[0].metadata = { billingUsageAggregated: true };
    expect(ContextBudgetService.estimateConversationTokens(conversation, 'system'))
      .toBe(Math.ceil('actual answer'.length / 4) + Math.ceil('system'.length / 4));
  });
});
