import { ConversationService } from '../../src/services/ConversationService';
import { ContextCompactionService } from '../../src/services/chat/ContextCompactionService';
import type { IStorageAdapter } from '../../src/database/interfaces/IStorageAdapter';
import type { ConversationMetadata, MessageData } from '../../src/types/storage/HybridStorageTypes';
import type { ConversationData } from '../../src/types/chat/ChatTypes';

function fixture() {
  const messages: MessageData[] = Array.from({ length: 1001 }, (_, index) => ({
    id: `m${index}`,
    conversationId: 'conversation',
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    timestamp: index,
    state: 'complete',
    sequenceNumber: index
  }));
  const metadata: ConversationMetadata = {
    id: 'conversation', title: 'Long chat', created: 1, updated: 1,
    vaultName: 'test', messageCount: messages.length,
    metadata: { compaction: { frontier: [{
      summary: 'The first 999 messages were summarized.',
      messagesRemoved: 999, messagesKept: 2, filesReferenced: [], topics: [],
      compactedAt: 1, boundaryMessageId: 'm999'
    }] } }
  };
  const getMessages = jest.fn(async (_id: string, options: { page: number; pageSize: number }) => {
    const start = options.page * options.pageSize;
    const items = messages.slice(start, start + options.pageSize);
    return {
      items, page: options.page, pageSize: options.pageSize,
      totalItems: messages.length, totalPages: Math.ceil(messages.length / options.pageSize),
      hasNextPage: start + options.pageSize < messages.length, hasPreviousPage: options.page > 0
    };
  });
  const adapter = {
    isReady: () => true,
    getConversation: jest.fn(async () => metadata),
    getMessages,
    getConversations: jest.fn(async () => ({
      items: [], page: 0, pageSize: 100, totalItems: 0, totalPages: 0,
      hasNextPage: false, hasPreviousPage: false
    }))
  } as unknown as IStorageAdapter;
  const service = new ConversationService(
    {} as ConstructorParameters<typeof ConversationService>[0],
    {} as ConstructorParameters<typeof ConversationService>[1],
    {} as ConstructorParameters<typeof ConversationService>[2],
    adapter
  );
  return { service, getMessages };
}

describe('ConversationService complete context', () => {
  it('loads every page without pagination so a later compaction boundary is visible', async () => {
    const { service, getMessages } = fixture();
    const conversation = await service.getConversation('conversation');
    expect(conversation?.messages).toHaveLength(1001);
    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(getMessages).toHaveBeenNthCalledWith(2, 'conversation', { page: 1, pageSize: 1000 });
    const active = ContextCompactionService.getMessagesAfterBoundary(
      conversation!.messages as unknown as ConversationData['messages'],
      conversation!.metadata as ConversationData['metadata']
    );
    expect(active.map(message => message.id)).toEqual(['m999', 'm1000']);
  });

  it('keeps an explicit pagination request to one page', async () => {
    const { service, getMessages } = fixture();
    const conversation = await service.getConversation('conversation', { page: 0, pageSize: 1000 });
    expect(conversation?.messages).toHaveLength(1000);
    expect(conversation?.messagePagination?.hasNextPage).toBe(true);
    expect(getMessages).toHaveBeenCalledTimes(1);
  });

  it('rejects an adapter that claims a next page but returns no messages', async () => {
    const { service, getMessages } = fixture();
    getMessages.mockImplementationOnce(async () => ({
      items: [], page: 0, pageSize: 1000, totalItems: 1001, totalPages: 2,
      hasNextPage: true, hasPreviousPage: false
    }));
    await expect(service.getConversation('conversation')).rejects.toThrow('no progress');
  });
});
