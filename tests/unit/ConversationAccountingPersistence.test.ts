import { ConversationService } from '../../src/services/ConversationService';
import type { IStorageAdapter } from '../../src/database/interfaces/IStorageAdapter';
import type { MessageData, ConversationMetadata } from '../../src/types/storage/HybridStorageTypes';
import type { ConversationMessage, IndividualConversation } from '../../src/types/storage/StorageTypes';
import type { FileSystemService } from '../../src/services/storage/FileSystemService';
import type { IndexManager } from '../../src/services/storage/IndexManager';
import { AnthropicContextBuilder } from '../../src/services/chat/builders/AnthropicContextBuilder';

describe('ConversationService hybrid accounting bridge', () => {
  it('writes accounting-only changes into durable message metadata while preserving provider blocks', async () => {
    const stored: MessageData = {
      id: 'assistant', conversationId: 'conversation', role: 'assistant', content: 'answer',
      timestamp: 1, state: 'complete', sequenceNumber: 0,
      metadata: { anthropicResponses: [{ content: [{ type: 'text', text: 'answer' }], toolCallIds: [], contentEndOffset: 6 }] },
    };
    const conversationMetadata: ConversationMetadata = {
      id: 'conversation', title: 'Test', created: 1, updated: 1, vaultName: 'test', messageCount: 1,
    };
    const updateMessage = jest.fn(async (_id: string, _messageId: string, updates: Partial<MessageData>) => {
      if (updates.metadata) stored.metadata = updates.metadata;
    });
    const adapter = {
      isReady: () => true,
      getConversation: async () => conversationMetadata,
      getConversations: async () => ({ items: [], page: 0, pageSize: 100, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }),
      getMessages: async () => ({ items: [stored], page: 0, pageSize: 200, totalItems: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false }),
      updateMessage,
      updateConversation: jest.fn(),
    } as unknown as IStorageAdapter;
    const service = new ConversationService(
      {} as ConstructorParameters<typeof ConversationService>[0],
      {} as ConstructorParameters<typeof ConversationService>[1],
      {} as ConstructorParameters<typeof ConversationService>[2],
      adapter
    );
    const updatedMessage = {
      id: 'assistant', role: 'assistant' as const, content: 'answer', timestamp: 1, state: 'complete' as const,
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cacheReadTokens: 80 },
      cost: { totalCost: 0.002, currency: 'USD' },
      provider: 'anthropic', model: 'claude-sonnet-4-6',
      metadata: { latestResponseUsage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } },
    };
    await service.updateConversation('conversation', { messages: [updatedMessage] } as Partial<IndividualConversation>);

    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(stored.metadata?.anthropicResponses).toEqual(expect.any(Array));
    expect(stored.metadata?.latestResponseUsage).toEqual(expect.objectContaining({ promptTokens: 100 }));
    const reloaded = await service.getConversation('conversation');
    expect(reloaded?.messages[0]).toEqual(expect.objectContaining({
      usage: updatedMessage.usage,
      cost: updatedMessage.cost,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    }));
    expect(reloaded?.messages[0].metadata?.anthropicResponses).toEqual(expect.any(Array));
  });
});

describe.each(['anthropic', 'openai'])('retry replay replacement with %s', (nextProvider) => {
  it('clears the previous provider response before persisting a regenerated answer', async () => {
    const stored: MessageData = {
      id: 'assistant', conversationId: 'conversation', role: 'assistant', content: 'OLD ANSWER',
      timestamp: 1, state: 'complete', sequenceNumber: 1,
      metadata: {
        anthropicResponses: [{ content: [{ type: 'text', text: 'OLD ANSWER' }], toolCallIds: [], contentEndOffset: 10 }],
        nexusMessageAccounting: { provider: 'anthropic', model: 'old-model' },
      },
    };
    const user: MessageData = {
      id: 'user', conversationId: 'conversation', role: 'user', content: 'prompt',
      timestamp: 0, state: 'complete', sequenceNumber: 0,
    };
    const conversationMetadata: ConversationMetadata = {
      id: 'conversation', title: 'Test', created: 1, updated: 1, vaultName: 'test', messageCount: 2,
    };
    const updateMessage = jest.fn(async (_id: string, _messageId: string, updates: Partial<MessageData>) => {
      Object.assign(stored, updates);
    });
    const adapter = {
      isReady: () => true,
      getConversation: async () => conversationMetadata,
      getConversations: async () => ({ items: [], page: 0, pageSize: 100, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }),
      getMessages: async () => ({ items: [user, stored], page: 0, pageSize: 200, totalItems: 2, totalPages: 1, hasNextPage: false, hasPreviousPage: false }),
      updateMessage,
      updateConversation: jest.fn(),
    } as unknown as IStorageAdapter;
    const service = new ConversationService(
      {} as ConstructorParameters<typeof ConversationService>[0],
      {} as ConstructorParameters<typeof ConversationService>[1],
      {} as ConstructorParameters<typeof ConversationService>[2],
      adapter
    );
    const retryMessage: ConversationMessage = {
      id: 'assistant', role: 'assistant', content: '', timestamp: 1, state: 'draft',
      metadata: undefined, replaceMetadata: true,
    };
    await service.updateConversation('conversation', { messages: [
      { id: 'user', role: 'user', content: 'prompt', timestamp: 0, state: 'complete' },
      retryMessage,
    ] } as Partial<IndividualConversation>);
    expect(updateMessage).toHaveBeenCalledWith('conversation', 'assistant', expect.objectContaining({ metadata: null }));
    expect(retryMessage.replaceMetadata).toBeUndefined();

    retryMessage.content = 'NEW ANSWER is longer';
    retryMessage.state = 'complete';
    retryMessage.provider = nextProvider;
    retryMessage.model = 'new-model';
    await service.updateConversation('conversation', { messages: [
      { id: 'user', role: 'user', content: 'prompt', timestamp: 0, state: 'complete' },
      retryMessage,
    ] } as Partial<IndividualConversation>);

    const reloaded = await service.getConversation('conversation');
    expect(reloaded?.messages[1].metadata?.anthropicResponses).toBeUndefined();
    expect(reloaded?.messages[1].provider).toBe(nextProvider);
    const replay = new AnthropicContextBuilder().buildContext(reloaded!);
    expect(replay).toEqual(expect.arrayContaining([{ role: 'assistant', content: 'NEW ANSWER is longer' }]));
    expect(JSON.stringify(replay)).not.toContain('OLD ANSWER');
  });
});

it('keeps the metadata replacement signal out of legacy JSON and consumes it after save', async () => {
  const oldMessage: ConversationMessage = {
    id: 'assistant', role: 'assistant', content: 'OLD ANSWER', timestamp: 1,
    metadata: { anthropicResponses: [{ content: [{ type: 'text', text: 'OLD ANSWER' }] }] },
  };
  const existing: IndividualConversation = {
    id: 'conversation', title: 'Test', created: 1, updated: 1, vault_name: 'test',
    message_count: 1, messages: [oldMessage],
  };
  const writeConversation = jest.fn(async (_id: string, _value: IndividualConversation) => undefined);
  const service = new ConversationService(
    {} as ConstructorParameters<typeof ConversationService>[0],
    { readConversation: async () => existing, writeConversation } as unknown as FileSystemService,
    { updateConversationInIndex: jest.fn() } as unknown as IndexManager
  );
  const retryMessage: ConversationMessage = {
    ...oldMessage, content: '', state: 'draft', metadata: undefined, replaceMetadata: true,
  };

  await service.updateConversation('conversation', { messages: [retryMessage] });

  expect(writeConversation).toHaveBeenCalledWith('conversation', expect.objectContaining({
    messages: [expect.objectContaining({ content: '', metadata: undefined })]
  }));
  expect(writeConversation.mock.calls[0][1].messages[0]).not.toHaveProperty('replaceMetadata');
  expect(retryMessage.replaceMetadata).toBeUndefined();
});
