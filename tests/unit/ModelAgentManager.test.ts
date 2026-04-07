import { ModelAgentManager } from '../../src/ui/chat/services/ModelAgentManager';
import { ConversationData } from '../../src/types/chat/ChatTypes';

type SelectedModel = {
  providerId: string;
  modelId: string;
  providerName: string;
  modelName: string;
  contextWindow: number;
};

type ModelAgentManagerWithSelectedModel = ModelAgentManager & {
  selectedModel: SelectedModel;
};

describe('ModelAgentManager', () => {
  function createConversation(content: string): ConversationData {
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
          conversationId: 'conv_1'
        }
      ]
    };
  }

  it('uses the shared compaction policy for supported non-webllm providers', () => {
    const manager = new ModelAgentManager(
      {},
      {
        onModelChanged: jest.fn(),
        onPromptChanged: jest.fn(),
        onSystemPromptChanged: jest.fn()
      }
    );

    (manager as ModelAgentManagerWithSelectedModel).selectedModel = {
      providerId: 'github-copilot',
      modelId: 'copilot-model',
      providerName: 'GitHub Copilot',
      modelName: 'Copilot',
      contextWindow: 128000
    };

    const shouldCompact = manager.shouldCompactBeforeSending(
      createConversation('A'.repeat(725_000)),
      'follow-up'
    );

    expect(shouldCompact).toBe(true);
  });

  it('uses the configured current conversation id when resolving the session id', async () => {
    const conversationService = {
      getConversation: jest.fn().mockImplementation(async (conversationId: string) => ({
        metadata: {
          chatSettings: {
            sessionId: conversationId === 'conv_1' ? 'session_123' : 'unexpected'
          }
        }
      }))
    };

    const manager = new ModelAgentManager(
      {},
      {
        onModelChanged: jest.fn(),
        onPromptChanged: jest.fn(),
        onSystemPromptChanged: jest.fn()
      },
      conversationService
    );

    manager.setCurrentConversationId('conv_1');

    const options = await manager.getMessageOptions();

    expect(conversationService.getConversation).toHaveBeenCalledWith('conv_1');
    expect(options.sessionId).toBe('session_123');
  });
});
