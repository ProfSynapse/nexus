import { TokenCalculator } from '../../src/ui/chat/utils/TokenCalculator';
import { ConversationData } from '../../src/types/chat/ChatTypes';

type MessageWithUsage = ConversationData['messages'][number] & {
  usage?: unknown;
};

function createMessage(usage?: unknown): MessageWithUsage {
  return {
    id: 'msg_1',
    role: 'assistant',
    content: 'This content should be ignored when usage is present.',
    timestamp: Date.now(),
    conversationId: 'conv_1',
    usage
  };
}

describe('TokenCalculator usage normalization', () => {
  it('counts camelCase prompt/completion/total usage fields', () => {
    const tokens = TokenCalculator.estimateTokenCount({
      id: 'conv_1',
      title: 'Conversation',
      created: 1,
      updated: 1,
      messages: [
        {
          id: 'msg_1',
          role: 'assistant',
          content: 'hello',
          timestamp: 1,
          conversationId: 'conv_1',
          usage: {
            promptTokens: 120,
            completionTokens: 30,
            totalTokens: 150
          }
        }
      ]
    });

    expect(tokens).toBe(150);
  });

  it('counts snake_case and anthropic-style usage fields', () => {
    const tokens = TokenCalculator.estimateTokenCount({
      id: 'conv_2',
      title: 'Conversation',
      created: 1,
      updated: 1,
      messages: [
        {
          id: 'msg_1',
          role: 'assistant',
          content: 'hello',
          timestamp: 1,
          conversationId: 'conv_2',
          usage: {
            prompt_tokens: 90,
            completion_tokens: 10,
            total_tokens: 100
          }
        },
        {
          id: 'msg_2',
          role: 'assistant',
          content: 'world',
          timestamp: 2,
          conversationId: 'conv_2',
          usage: {
            input_tokens: 70,
            output_tokens: 20
          }
        }
      ]
    });

    // The last provider response reports the current prompt, which already
    // includes earlier conversation turns; summing both would count them twice.
    expect(tokens).toBe(90);
  });

  it('falls back to estimated message content when usage shape is not recognized', () => {
    const tokens = TokenCalculator.estimateTokenCount({
      id: 'conv_3',
      title: 'Conversation',
      created: 1,
      updated: 1,
      messages: [
        {
          id: 'msg_1',
          role: 'assistant',
          content: '12345678',
          timestamp: 1,
          conversationId: 'conv_3',
          usage: {
            unrelated: 999
          }
        }
      ]
    });

    expect(tokens).toBe(2);
  });
});

function createConversation(usage?: unknown): ConversationData {
  return {
    id: 'conv_1',
    title: 'Test',
    created: Date.now(),
    updated: Date.now(),
    messages: [
      createMessage(usage)
    ]
  };
}

describe('TokenCalculator', () => {
  it('uses the saved effective model limit for the context meter', () => {
    const model = {
      providerId: 'openai-codex', providerName: 'ChatGPT',
      modelId: 'gpt-6.1-sol', modelName: 'GPT-6.1 Sol', contextWindow: 1_050_000
    };
    const conversation = createConversation({ promptTokens: 80_000, completionTokens: 20_000, totalTokens: 100_000 });

    const usage = TokenCalculator.getContextUsage(model, conversation, null, 200_000);

    expect(usage.total).toBe(200_000);
    expect(usage.used).toBe(100_000);
    expect(usage.percentage).toBe(50);
  });

  it('uses normalized usage data when camelCase usage is present', () => {
    const conversation = createConversation({
      promptTokens: 21,
      completionTokens: 13,
      totalTokens: 34
    });

    expect(TokenCalculator.estimateTokenCount(conversation)).toBe(34);
  });

  it('uses normalized usage data when snake_case usage is present', () => {
    const conversation = createConversation({
      prompt_tokens: 20,
      completion_tokens: 5,
      total_tokens: 25
    });

    expect(TokenCalculator.estimateTokenCount(conversation)).toBe(25);
  });

  it('falls back to text estimation when the stored usage is empty', () => {
    const conversation = {
      id: 'conv_1',
      title: 'Test',
      created: Date.now(),
      updated: Date.now(),
      messages: [
        {
          id: 'msg_1',
          role: 'assistant' as const,
          content: '12345678',
          timestamp: Date.now(),
          conversationId: 'conv_1',
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0
          }
        }
      ]
    };

    expect(TokenCalculator.estimateTokenCount(conversation)).toBe(2);
  });
});
