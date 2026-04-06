import { MistralAdapter } from '../../src/services/llm/adapters/mistral/MistralAdapter';
import { GenerateOptions, StreamChunk } from '../../src/services/llm/adapters/types';

class TestMistralAdapter extends MistralAdapter {
  lastStreamBody: Record<string, unknown> | undefined;

  protected override requestStream(config: {
    body: string;
  }): Promise<NodeJS.ReadableStream> {
    this.lastStreamBody = JSON.parse(config.body) as Record<string, unknown>;
    return Promise.resolve({} as NodeJS.ReadableStream);
  }

  protected override async* processNodeStream(): AsyncGenerator<StreamChunk, void, unknown> {
    yield {
      content: '',
      complete: true
    };
  }
}

describe('MistralAdapter', () => {
  it('normalizes continuation messages to Mistral-safe tool payloads', async () => {
    const adapter = new TestMistralAdapter('test-key');
    const conversationHistory = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tool-call_12345',
            type: 'function',
            function: {
              name: 'storageManager_list',
              arguments: '{"path":"/"}'
            },
            index: 0,
            reasoning_details: [{ ignored: true }]
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'tool-call_12345',
        content: '{"files":[]}'
      }
    ];

    const options: GenerateOptions = {
      model: 'mistral-large-latest',
      conversationHistory
    };

    for await (const _chunk of adapter.generateStreamAsync('', options)) {
      // Exhaust the generator to capture the serialized request body.
    }

    const body = adapter.lastStreamBody;
    expect(body).toBeDefined();

    const messages = body?.messages as Array<Record<string, unknown>>;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages).toHaveLength(2);

    const assistantMessage = messages[0];
    const toolMessage = messages[1];
    const assistantToolCalls = assistantMessage?.tool_calls as Array<Record<string, unknown>>;
    const assistantToolCall = assistantToolCalls?.[0];
    const normalizedId = assistantToolCall?.id as string;

    expect(normalizedId).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(assistantToolCall).toEqual({
      id: normalizedId,
      type: 'function',
      function: {
        name: 'storageManager_list',
        arguments: '{"path":"/"}'
      }
    });

    expect(toolMessage).toEqual({
      role: 'tool',
      tool_call_id: normalizedId,
      name: 'storageManager_list',
      content: '{"files":[]}'
    });
  });
});
