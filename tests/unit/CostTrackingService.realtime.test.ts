import { CostTrackingService } from '../../src/services/chat/CostTrackingService';
import { CostCalculator } from '../../src/services/llm/adapters/CostCalculator';
import { TokenUsageExtractor } from '../../src/services/llm/utils/TokenUsageExtractor';
import type { ConversationData } from '../../src/types/chat/ChatTypes';

describe('CostTrackingService live accounting', () => {
  it('replaces the same response snapshot instead of charging every update', async () => {
    const conversation = {
      id: 'conversation',
      messages: [{ id: 'assistant', role: 'assistant', content: '' }],
      cost: { totalCost: 0.1, currency: 'USD' },
    } as ConversationData;
    const updateConversation = jest.fn(async (_id: string, updates: Partial<ConversationData>) => {
      Object.assign(conversation, updates);
    });
    const service = new CostTrackingService({
      getConversation: async () => conversation,
      updateConversation,
    });
    const usage = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };

    await service.updateMessageCost('conversation', 'assistant', usage, { totalCost: 0.02, currency: 'USD' });
    await service.updateMessageCost('conversation', 'assistant', usage, { totalCost: 0.02, currency: 'USD' });
    await service.updateMessageCost('conversation', 'assistant', usage, { totalCost: 0.03, currency: 'USD' });

    expect(conversation.cost?.totalCost).toBeCloseTo(0.13);
    expect(updateConversation).toHaveBeenCalledTimes(3);
  });

  it('adds callback usage for separate responses after the stream has committed', async () => {
    const conversation = {
      id: 'conversation',
      messages: [{ id: 'assistant', role: 'assistant', content: '', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 }, cost: { totalCost: 0.02, currency: 'USD' } }],
      cost: { totalCost: 0.12, currency: 'USD' },
    } as ConversationData;
    const service = new CostTrackingService({
      getConversation: async () => conversation,
      updateConversation: async (_id, updates) => { Object.assign(conversation, updates); },
    });
    const callback = service.createUsageCallback('conversation', 'assistant');
    await callback({ promptTokens: 200, completionTokens: 20, totalTokens: 220 }, { totalCost: 0.03, currency: 'USD' });
    await callback({ promptTokens: 300, completionTokens: 30, totalTokens: 330 }, { totalCost: 0.04, currency: 'USD' });
    expect(conversation.messages[0].usage?.promptTokens).toBe(600);
    expect(conversation.messages[0].cost?.totalCost).toBeCloseTo(0.09);
    expect(conversation.cost?.totalCost).toBeCloseTo(0.19);
    expect(conversation.messages[0].metadata?.billingUsageAggregated).toBe(true);
  });
});

describe('provider reported charge', () => {
  it('uses a reported dollar amount when a gateway model is absent from the registry', () => {
    const result = CostCalculator.calculateCostFromUsage('openrouter', 'unlisted/model', {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      providerCost: { totalCost: 0.42, currency: 'USD' },
    });
    expect(result?.totalCost).toBe(0.42);
    expect(result?.providerReported).toBe(true);
  });
});

describe('Anthropic cache pricing in the chat counter', () => {
  it('includes fresh, cache read, cache write, and output classes once', () => {
    const raw = {
      input_tokens: 1000,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 1000,
      output_tokens: 100,
    };
    const usage = TokenUsageExtractor.normalize(raw);
    expect(usage?.promptTokens).toBe(10000);
    const service = new CostTrackingService({
      getConversation: async () => null,
      updateConversation: async () => undefined,
    });
    expect(service.calculateCost('anthropic', 'claude-sonnet-4-6', usage!)?.totalCost).toBeCloseTo(0.01065);
  });
});
