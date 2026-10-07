/** Real message builder: repeated tool rounds must not drop prose, repeat the user, or lose cancellation. */
import { ProviderMessageBuilder, type ConversationMessage } from '../../src/services/llm/core/ProviderMessageBuilder';

describe('generic endpoint continuation', () => {
  it('replays full structured history across two tool rounds and retains normal settings', () => {
    const builder = new ProviderMessageBuilder(new Map());
    const controller = new AbortController();
    const initial = builder.buildInitialOptions('openai-compatible-home', 'org/model:tag', [
      { role: 'system', content: 'System instructions' },
      { role: 'user', content: 'Read both notes.' },
    ], { abortSignal: controller.signal, temperature: 0.2, maxTokens: 512 }).generateOptions;
    const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'read_note', arguments: '{}' } });
    const first = builder.buildContinuationOptions('openai-compatible-home', 'Read both notes.', [call('a')],
      [{ id: 'a', name: 'read_note', success: true, result: 'First note' }], [],
      { ...initial, assistantResponseText: 'Reading the first note.' });
    const second = builder.buildContinuationOptions('openai-compatible-home', 'Read both notes.', [call('b')],
      [{ id: 'b', name: 'read_note', success: true, result: 'Second note' }], [],
      { ...first, assistantResponseText: 'Now the second.' });
    const messages = second.conversationHistory as ConversationMessage[];
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
    expect(messages[1]).toMatchObject({ content: 'Reading the first note.', tool_calls: [{ id: 'a' }] });
    expect(messages[3]).toMatchObject({ content: 'Now the second.', tool_calls: [{ id: 'b' }] });
    expect(messages[2]).toMatchObject({ tool_call_id: 'a', content: '"First note"' });
    expect(messages[4]).toMatchObject({ tool_call_id: 'b', content: '"Second note"' });
    expect(second.systemPrompt).toBe('System instructions');
    expect(second.abortSignal).toBe(controller.signal);
    expect(second.temperature).toBe(0.2);
    expect(second.maxTokens).toBe(512);
  });
});
