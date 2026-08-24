import { ChatService } from '../../src/services/chat/ChatService';

describe('ChatService terminal results', () => {
  it('returns failure when the runtime emits turn.failed in-band', async () => {
    const service = new ChatService({
      conversationService: {} as never,
      llmService: {} as never,
      vaultName: 'test',
      mcpConnector: { executeTool: jest.fn() },
    });
    const failedManager = {
      sendMessage: async function* () {
        yield {
          messageId: 'assistant-1',
          event: { type: 'turn.failed' as const, error: { message: 'provider failed' } },
        };
      },
    };
    (service as unknown as { conversationManager: typeof failedManager }).conversationManager = failedManager;

    await expect(service.sendMessage('conversation-1', 'hello')).resolves.toEqual({
      success: false,
      messageId: 'assistant-1',
      error: 'provider failed',
    });
  });
});
