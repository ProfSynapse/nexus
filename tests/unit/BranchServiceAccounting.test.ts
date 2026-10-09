import { BranchService } from '../../src/services/chat/BranchService';
import type { ConversationService } from '../../src/services/ConversationService';
import type { ChatMessage } from '../../src/types/chat/ChatTypes';

describe('BranchService accounting persistence', () => {
  it('forwards provider accounting with a branch message', async () => {
    const addMessage = jest.fn().mockResolvedValue({ success: true });
    const service = new BranchService({
      conversationService: { addMessage } as unknown as ConversationService
    });
    const message: ChatMessage = {
      id: 'old-answer', role: 'assistant', content: 'Old answer',
      conversationId: 'parent', timestamp: 1,
      metadata: { anthropicResponses: ['provider payload'] },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      cost: { totalCost: 0.04, currency: 'USD' },
      provider: 'anthropic', model: 'claude-test'
    };

    await service.addMessageToBranch('branch', message);

    expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'branch', id: 'old-answer',
      metadata: message.metadata, usage: message.usage, cost: message.cost,
      provider: 'anthropic', model: 'claude-test'
    }));
  });
});
