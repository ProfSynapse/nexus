import { OpenAIContextBuilder } from '../../src/services/chat/builders/OpenAIContextBuilder';
import { ConversationData } from '../../src/types/chat/ChatTypes';

describe('OpenAIContextBuilder', () => {
  it('includes tool names on tool result messages', () => {
    const builder = new OpenAIContextBuilder();
    const conversation: ConversationData = {
      id: 'conv-1',
      title: 'Test',
      created: 1,
      updated: 1,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          timestamp: 1,
          conversationId: 'conv-1',
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'storageManager_list',
                arguments: '{"path":"/"}'
              },
              result: { files: [] },
              success: true
            }
          ]
        }
      ]
    };

    const messages = builder.buildContext(conversation);
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'storageManager_list',
              arguments: '{"path":"/"}'
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        name: 'storageManager_list',
        content: '{"files":[]}'
      }
    ]);
  });
});
