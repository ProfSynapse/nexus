import { ConversationService } from '../../src/services/ConversationService';
import type { IStorageAdapter } from '../../src/database/interfaces/IStorageAdapter';
import type { Plugin } from 'obsidian';
import type { FileSystemService } from '../../src/services/storage/FileSystemService';
import type { IndexManager } from '../../src/services/storage/IndexManager';
import { MessageStateManager } from '../../src/ui/chat/services/MessageStateManager';
import type { ChatService } from '../../src/services/chat/ChatService';
import { createConversation } from '../fixtures/chatBugs';

// The actual service chooses the write scope and metadata merge. The adapter
// is only an in-memory persistence boundary; it does not choose the payload.
describe('targeted chat writes', () => {
  it('updates one message without replacing the transcript or losing accounting', async () => {
    const adapter = {
      isReady: () => true,
      getMessage: jest.fn(async () => ({ id: 'm', conversationId: 'c', metadata: {
        other: 'retained', nexusMessageAccounting: { provider: 'test', cost: { totalCost: 0.5, currency: 'USD' } },
      } })),
      updateMessage: jest.fn(async () => undefined),
      updateConversation: jest.fn(), deleteMessage: jest.fn(),
    };
    const service = new ConversationService({} as Plugin, {} as FileSystemService, {} as IndexManager, adapter as unknown as IStorageAdapter);
    await service.updateChatMessage('c', 'm', { content: 'answer', reasoning: 'plan' });
    expect(adapter.updateMessage).toHaveBeenCalledWith('c', 'm', expect.objectContaining({
      content: 'answer', reasoning: 'plan', metadata: expect.objectContaining({
        other: 'retained', nexusMessageAccounting: expect.objectContaining({ cost: { totalCost: 0.5, currency: 'USD' } }),
      }),
    }));
    expect(adapter.updateConversation).not.toHaveBeenCalled();
    expect(adapter.deleteMessage).not.toHaveBeenCalled();
  });
  it('rejects missing targets instead of resurrecting deleted messages', async () => {
    const updateMessage = jest.fn();
    const adapter = { isReady: () => true, getMessage: async () => null, updateMessage };
    const service = new ConversationService({} as Plugin, {} as FileSystemService, {} as IndexManager, adapter as unknown as IStorageAdapter);
    await expect(service.updateChatMessage('c', 'm', { content: 'late' })).rejects.toThrow('no longer exists');
    expect(updateMessage).not.toHaveBeenCalled();
  });
  it('stops the send prerequisite when the user message cannot be saved', async () => {
    const conversation = createConversation({ messages: [] });
    const updated = jest.fn();
    const service = { addMessage: async () => ({ success: false, error: 'disk unavailable' }) };
    const manager = new MessageStateManager(service as unknown as ChatService, {
      onMessageAdded: jest.fn(), onAIMessageStarted: jest.fn(), onMessageIdUpdated: jest.fn(), onConversationUpdated: updated,
    });
    await expect(manager.addUserMessage(conversation, 'question')).rejects.toThrow('disk unavailable');
    expect(conversation.messages).toEqual([]);
    expect(updated).toHaveBeenCalledWith(conversation);
  });
});

describe('updateConversation fast path', () => {
  // Stored the way a replayed cache holds tool calls: the event's subset.
  const storedCall = (id: string, result?: unknown) => ({
    id, type: 'function', function: { name: 'useTools', arguments: '{}' }, name: 'useTools',
    ...(result === undefined ? {} : { result, success: true })
  });
  // Held the way the live chat holds them: extra display fields.
  const liveCall = (id: string, result?: unknown) => ({
    ...storedCall(id, result), displayName: 'Use tools', technicalName: 'toolManager_useTools', executionTime: 12
  });

  function serviceWith(storedToolCalls: unknown[]) {
    const adapter = {
      isReady: () => true,
      getConversation: jest.fn(async () => ({ id: 'c', metadata: {} })),
      getMessages: jest.fn(async () => ({
        items: [{ id: 'm', conversationId: 'c', role: 'assistant', content: 'Done', state: 'complete', timestamp: 1, sequenceNumber: 0, toolCalls: storedToolCalls }],
        hasNextPage: false
      })),
      updateMessage: jest.fn(async () => undefined),
      deleteMessage: jest.fn(async () => undefined),
      updateConversation: jest.fn(async () => undefined)
    };
    const service = new ConversationService({} as Plugin, {} as FileSystemService, {} as IndexManager, adapter as unknown as IStorageAdapter);
    return { service, adapter };
  }

  const message = (toolCalls: unknown[]) => ({ id: 'm', role: 'assistant', content: 'Done', state: 'complete', timestamp: 1, toolCalls });

  it('saves a change that only touches tool calls (abort stripping an incomplete call)', async () => {
    const { service, adapter } = serviceWith([storedCall('done', { ok: true }), storedCall('incomplete')]);

    await service.updateConversation('c', { messages: [message([liveCall('done', { ok: true })])] } as never);

    expect(adapter.updateMessage).toHaveBeenCalledTimes(1);
    const written = (adapter.updateMessage.mock.calls[0] as unknown[])[2] as { toolCalls: Array<{ id: string }> };
    expect(written.toolCalls.map(call => call.id)).toEqual(['done']);
  });

  it('still skips a message whose tool calls differ from the cache only in shape', async () => {
    const { service, adapter } = serviceWith([storedCall('done', { ok: true })]);

    await service.updateConversation('c', { messages: [message([liveCall('done', { ok: true })])] } as never);

    expect(adapter.updateMessage).not.toHaveBeenCalled();
  });
});
