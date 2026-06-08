import { LiveVoiceContextBuilder } from '../../src/services/realtimeVoice/LiveVoiceContextBuilder';
import type { ConversationData, ConversationMessage } from '../../src/types/chat/ChatTypes';

function message(
  id: string,
  role: 'user' | 'assistant' | 'tool' | 'system',
  content: string,
  metadata?: Record<string, unknown>
): ConversationMessage {
  return {
    id,
    role,
    content,
    timestamp: Date.now(),
    conversationId: 'conversation-1',
    metadata,
  };
}

function conversation(messages: ConversationMessage[], metadata: ConversationData['metadata'] = {}): ConversationData {
  return {
    id: 'conversation-1',
    title: 'Conversation',
    messages,
    created: Date.now(),
    updated: Date.now(),
    metadata,
  };
}

describe('LiveVoiceContextBuilder', () => {
  it('returns an empty context for missing or empty conversations', () => {
    const builder = new LiveVoiceContextBuilder();

    expect(builder.build(null)).toBe('');
    expect(builder.build(conversation([]))).toBe('');
  });

  it('includes compaction summaries and only recent visible user and assistant messages after the boundary', () => {
    const builder = new LiveVoiceContextBuilder();
    const context = builder.build(conversation([
      message('old-user', 'user', 'Old user message before compaction.'),
      message('boundary-user', 'user', 'Current user question.'),
      message('tool-1', 'tool', 'Tool output should not appear.'),
      message('hidden-assistant', 'assistant', 'Hidden assistant message.', { hidden: true }),
      message('assistant-1', 'assistant', 'Current assistant answer with <special> & characters.'),
    ], {
      compaction: {
        frontier: [
          {
            summary: 'Earlier work summarized here.',
            messagesRemoved: 1,
            messagesKept: 2,
            filesReferenced: ['Project.md'],
            topics: ['live voice'],
            compactedAt: 123,
            boundaryMessageId: 'boundary-user',
          },
        ],
      },
    }));

    expect(context).toContain('<conversation_context>');
    expect(context).toContain('Earlier work summarized here.');
    expect(context).toContain('Project.md');
    expect(context).toContain('Current user question.');
    expect(context).toContain('Current assistant answer with &lt;special&gt; &amp; characters.');
    expect(context).not.toContain('Old user message before compaction.');
    expect(context).not.toContain('Tool output should not appear.');
    expect(context).not.toContain('Hidden assistant message.');
  });

  it('drops oldest recent messages until the context fits the token budget', () => {
    const builder = new LiveVoiceContextBuilder({
      maxContextTokens: 120,
      maxMessageChars: 2_000,
    });
    const context = builder.build(conversation([
      message('u1', 'user', 'First old visible message '.repeat(60)),
      message('a1', 'assistant', 'Second old visible message '.repeat(60)),
      message('u2', 'user', 'Final user request'),
      message('a2', 'assistant', 'Final assistant response'),
    ]));

    expect(context).not.toContain('First old visible message');
    expect(context).not.toContain('Second old visible message');
    expect(context).toContain('Final user request');
    expect(context).toContain('Final assistant response');
  });
});
