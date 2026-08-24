import { mapProviderStreamChunk } from '../../src/services/llm/runtime/ProviderStreamEventMapper';

describe('ProviderStreamEventMapper', () => {
  it('separates every provider concern and keeps response completion non-terminal', () => {
    const events = mapProviderStreamChunk({
      content: 'Answer',
      complete: true,
      reasoning: 'Think',
      reasoningComplete: true,
      reasoningId: 'reason-1',
      reasoningEncryptedContent: 'opaque',
      toolCalls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'content_read', arguments: '{"path":"note.md"}' },
      }],
      toolCallsReady: true,
      usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 },
      metadata: { responseId: 'response-1' },
    });

    expect(events).toEqual([
      { type: 'assistant.delta', text: 'Answer' },
      {
        type: 'reasoning.delta',
        text: 'Think',
        blockId: 'reason-1',
        encryptedContent: 'opaque',
      },
      { type: 'reasoning.completed', blockId: 'reason-1' },
      {
        type: 'tool.snapshot',
        calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'content_read', arguments: '{"path":"note.md"}' },
        }],
        ready: true,
      },
      {
        type: 'usage.updated',
        usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 },
      },
      { type: 'response.metadata', metadata: { responseId: 'response-1' } },
      { type: 'response.completed', finishReason: 'tool_calls' },
    ]);

    expect(events.some(event => event.type.startsWith('turn.'))).toBe(false);
  });
});
