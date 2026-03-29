import { ContextBudgetService } from '../../src/services/chat/ContextBudgetService';
import { ConversationData } from '../../src/types/chat/ChatTypes';

function createConversationWithContent(content: string, usage?: unknown): ConversationData {
  return {
    id: 'conv_1',
    title: 'Test',
    created: Date.now(),
    updated: Date.now(),
    messages: [
      {
        id: 'msg_1',
        role: 'assistant',
        content,
        timestamp: Date.now(),
        conversationId: 'conv_1',
        usage: usage as any
      }
    ]
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
});
