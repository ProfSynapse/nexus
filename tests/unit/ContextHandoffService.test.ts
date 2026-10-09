import { ContextHandoffService, type HandoffPreparationInput } from '../../src/services/chat/ContextHandoffService';
import { ContextCompactionService } from '../../src/services/chat/ContextCompactionService';
import type { ConversationData, ConversationMessage } from '../../src/types/chat/ChatTypes';

function message(id: string, role: ConversationMessage['role'], content: string): ConversationMessage {
  return { id, role, content, timestamp: 1, conversationId: 'c' };
}

function input(messages: ConversationMessage[], destinationWindow: number): HandoffPreparationInput {
  return {
    conversation: { id: 'c', title: 'Test', created: 1, updated: 1, messages } as ConversationData,
    source: { providerId: 'openai', modelId: 'large', contextWindow: 250_000 },
    destination: { providerId: 'openai', modelId: 'small', contextWindow: destinationWindow },
    systemPrompt: 'Instructions',
    summarizer: jest.fn().mockResolvedValue('The user asked for help. The tool found a result.'),
  };
}

describe('ContextHandoffService', () => {
  it('skips summary when an increase or same-size switch fits the destination', async () => {
    const args = input([message('u1', 'user', 'short request')], 300_000);
    expect(await new ContextHandoffService().prepare(args)).toBeUndefined();
    expect(args.summarizer).not.toHaveBeenCalled();
  });

  it('summarizes a 250K transcript for a 128K destination and keeps complete recent exchanges', async () => {
    const messages = [
      message('u1', 'user', 'x'.repeat(540_000)),
      message('a1', 'assistant', 'I completed the first step'),
      message('u2', 'user', 'Please continue'),
      message('a2', 'assistant', 'Continuing')
    ];
    const args = input(messages, 128_000);
    const candidate = await new ContextHandoffService().prepare(args);
    expect(candidate?.boundaryMessageId).toBe('u2');
    expect(candidate?.messagesRemoved).toBe(2);
    expect(args.summarizer).toHaveBeenCalledWith(messages.slice(0, 2), expect.objectContaining({
      provider: 'openai', model: 'large', sourceContextWindow: 250_000
    }));
    expect(args.conversation.messages).toHaveLength(4);
  });

  it('compacts a same-model context shrink and includes large tool outcomes in sizing', async () => {
    const args = input([
      message('u1', 'user', 'Search'),
      { ...message('a1', 'assistant', ''), toolCalls: [{
        id: 't1', type: 'function' as const, function: { name: 'search', arguments: '{}' }, result: 'z'.repeat(70_000)
      }] },
      message('u2', 'user', 'Thanks'), message('a2', 'assistant', 'Done')
    ], 16_000);
    args.source = { providerId: 'openai', modelId: 'small', contextWindow: 128_000 };
    args.destination.modelId = 'small';
    const candidate = await new ContextHandoffService().prepare(args);
    expect(candidate?.boundaryMessageId).toBe('u2');
    expect(candidate?.messagesRemoved).toBe(2);
  });

  it('summarizes an oversized final exchange and admits future messages', async () => {
    const args = input([message('u1', 'user', 'y'.repeat(90_000))], 16_000);
    const candidate = await new ContextHandoffService().prepare(args);
    expect(candidate?.boundaryMode).toBe('after');
    expect(candidate?.boundaryMessageId).toBe('u1');
    const metadata = { compaction: { frontier: [candidate] } } as ConversationData['metadata'];
    expect(ContextCompactionService.getMessagesAfterBoundary(args.conversation.messages, metadata)).toEqual([]);
    const next = message('u2', 'user', 'Follow-up');
    expect(ContextCompactionService.getMessagesAfterBoundary([...args.conversation.messages, next], metadata)).toEqual([next]);
  });

  it('does not skip a handoff when provider usage reports a larger prompt than text estimation', async () => {
    const args = input([
      message('u1', 'user', 'Earlier task'),
      { ...message('a1', 'assistant', 'Done'), usage: { promptTokens: 180_000, completionTokens: 100, totalTokens: 180_100 } }
    ], 128_000);
    const candidate = await new ContextHandoffService().prepare(args);
    expect(candidate?.messagesRemoved).toBe(2);
    expect(args.summarizer).toHaveBeenCalled();
  });

  it('rejects cancellation and oversized summaries before any commit', async () => {
    const args = input([message('u1', 'user', 'x'.repeat(90_000))], 16_000);
    const controller = new AbortController();
    args.signal = controller.signal;
    args.summarizer = jest.fn().mockImplementation(async () => { controller.abort(); return 'summary'; });
    await expect(new ContextHandoffService().prepare(args)).rejects.toThrow('cancelled');
    expect(args.conversation.metadata?.compaction).toBeUndefined();

    args.signal = undefined;
    args.summarizer = jest.fn().mockResolvedValue('too long '.repeat(20_000));
    await expect(new ContextHandoffService().prepare(args)).rejects.toThrow('exceeds');
  });
});
