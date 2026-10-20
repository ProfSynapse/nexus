import { AnthropicContextBuilder } from '../../src/services/chat/builders/AnthropicContextBuilder';
import { OpenAIContextBuilder } from '../../src/services/chat/builders/OpenAIContextBuilder';
import { GoogleContextBuilder } from '../../src/services/chat/builders/GoogleContextBuilder';
import { CustomFormatContextBuilder } from '../../src/services/chat/builders/CustomFormatContextBuilder';
import type { IContextBuilder, LLMToolCall, ToolExecutionResult } from '../../src/services/chat/builders/IContextBuilder';
import { convertToLegacyConversation } from '../../src/services/helpers/ConversationTypeConverters';
import type { MessageData } from '../../src/types/storage/HybridStorageTypes';

/**
 * A stored chat that once read a 3 MB note. On later turns the model gets the
 * head and tail of that result, in every provider format. The turn that ran
 * the tool still gets the result whole (continuation).
 */
const BIG = `HEAD-OF-NOTE ${'body '.repeat(600_000)} TAIL-OF-NOTE`; // ~3 MB

function storedChat(): ReturnType<typeof convertToLegacyConversation> {
  const messages: MessageData[] = [
    { id: 'u1', conversationId: 'c1', role: 'user', content: 'Summarise Big.md', timestamp: 1, state: 'complete', sequenceNumber: 0 },
    {
      id: 'a1', conversationId: 'c1', role: 'assistant', content: 'Here is the summary.', timestamp: 2, state: 'complete', sequenceNumber: 1,
      toolCalls: [{
        id: 'call_1', type: 'function', name: 'useTools',
        function: { name: 'useTools', arguments: JSON.stringify({ tool: 'content read --path Big.md' }) },
        parameters: { tool: 'content read --path Big.md' },
        result: { success: true, path: 'Big.md', content: BIG },
        success: true
      }]
    },
    { id: 'u2', conversationId: 'c1', role: 'user', content: 'Now list its headings', timestamp: 3, state: 'complete', sequenceNumber: 2 }
  ];
  return convertToLegacyConversation({
    id: 'c1', title: 'Big note', created: 1, updated: 3, vaultName: 'test', messageCount: messages.length
  }, messages);
}

const builders: Array<[string, IContextBuilder]> = [
  ['anthropic', new AnthropicContextBuilder()],
  ['openai', new OpenAIContextBuilder()],
  ['google', new GoogleContextBuilder()],
  ['custom', new CustomFormatContextBuilder()]
];

describe.each(builders)('%s history replay of a very large stored tool result', (_name, builder) => {
  it('sends the head and tail with a trim note, not the whole 3 MB', () => {
    const serialized = JSON.stringify(builder.buildContext(storedChat() as never));
    expect(serialized).toContain('HEAD-OF-NOTE');
    expect(serialized).toContain('TAIL-OF-NOTE');
    expect(serialized).toContain('Nexus trimmed this tool result');
    expect(serialized.length).toBeLessThan(400 * 1024);
  });

  it('still gives the current turn the full result in its continuation', () => {
    const calls: LLMToolCall[] = [{ id: 'call_1', type: 'function', function: { name: 'useTools', arguments: '{}' } }];
    const results: ToolExecutionResult[] = [{ id: 'call_1', success: true, result: { success: true, content: BIG } }];
    const serialized = JSON.stringify(builder.buildToolContinuation('Summarise Big.md', calls, results));
    expect(serialized).not.toContain('Nexus trimmed this tool result');
    expect(serialized.length).toBeGreaterThan(BIG.length);
  });
});

describe('google history replay', () => {
  it('always sends functionResponse.response as an object', () => {
    const chat = storedChat();
    const stored = chat.messages[1] as unknown as { toolCalls: Array<{ result: unknown }> };
    stored.toolCalls[0].result = 'a plain string result';
    const messages = new GoogleContextBuilder().buildContext(chat as never) as unknown as Array<{ parts?: Array<{ functionResponse?: { response: unknown } }> }>;
    const response = messages.flatMap(message => message.parts ?? []).find(part => part.functionResponse)?.functionResponse?.response;
    expect(response).toEqual({ content: 'a plain string result' });
  });
});
