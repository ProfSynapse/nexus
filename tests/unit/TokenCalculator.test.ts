import { TokenCalculator } from '../../src/ui/chat/utils/TokenCalculator';
import { ConversationData } from '../../src/types/chat/ChatTypes';

function createConversation(usage?: unknown): ConversationData {
  return {
    id: 'conv_1',
    title: 'Test',
    created: Date.now(),
    updated: Date.now(),
    messages: [
      {
        id: 'msg_1',
        role: 'assistant',
        content: 'This content should be ignored when usage is present.',
        timestamp: Date.now(),
        conversationId: 'conv_1',
        usage: usage as any
      }
    ]
  };
}

describe('TokenCalculator', () => {
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
