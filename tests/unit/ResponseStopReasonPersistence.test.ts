import { mapProviderStreamChunk } from '../../src/services/llm/runtime/ProviderStreamEventMapper';
import { createInitialChatTurnState, reduceChatTurn } from '../../src/services/llm/runtime/ChatTurnReducer';
import type { ChatRuntimeEvent } from '../../src/services/llm/runtime/ChatRuntimeEvent';
import { MessageStreamHandler } from '../../src/ui/chat/services/MessageStreamHandler';
import { StreamingResponseService } from '../../src/services/chat/StreamingResponseService';
import type { ChatService } from '../../src/services/chat/ChatService';
import type { ConversationData } from '../../src/types/chat/ChatTypes';
import { createAssistantMessage, createConversation, createUserMessage } from '../fixtures/chatBugs';
import { createMockChatService } from '../mocks/chatService';

const toolCall = {
  id: 'tool-1',
  type: 'function' as const,
  function: { name: 'content_read', arguments: '{"path":"note.md"}' },
};

function responseEvents(): ChatRuntimeEvent[] {
  return [
    { type: 'response.resolved', provider: 'anthropic', model: 'claude-haiku-5-5' },
    ...mapProviderStreamChunk({
      content: '', complete: true, toolCalls: [toolCall],
      finishReason: 'tool_calls',
      metadata: { stopReason: 'tool_use', stopSequence: null },
    }),
    { type: 'tool.execution.completed', operationId: 'tool-1', call: {
      ...toolCall, result: { content: 'note' }, success: true,
    }, success: true },
    ...mapProviderStreamChunk({
      content: 'Partial answer', complete: true,
      finishReason: 'length',
      metadata: { stopReason: 'max_tokens', stopSequence: 'older-sequence' },
    }),
    ...mapProviderStreamChunk({
      content: ' Final answer', complete: true,
      finishReason: 'stop',
      metadata: { stopReason: 'end_turn', stopSequence: null },
    }),
  ];
}

const expectedStops = [
  { provider: 'anthropic', model: 'claude-haiku-5-5', stopReason: 'tool_use', finishReason: 'tool_calls', stopSequence: null },
  { provider: 'anthropic', model: 'claude-haiku-5-5', stopReason: 'max_tokens', finishReason: 'length', stopSequence: 'older-sequence' },
  { provider: 'anthropic', model: 'claude-haiku-5-5', stopReason: 'end_turn', finishReason: 'stop', stopSequence: null },
];

function conversation(): ConversationData {
  return createConversation({ messages: [
    createUserMessage({ id: 'user-1', content: 'Read and summarize' }),
    createAssistantMessage({ id: 'assistant-1', content: '', state: 'draft', isLoading: true }),
  ] });
}

function streamOf(events: ChatRuntimeEvent[]) {
  return async function* () {
    for (const event of events) yield { messageId: 'assistant-1', event };
  };
}

describe('response stop reason persistence', () => {
  it('retains every mapped provider response boundary and clears a prior stop sequence with null', () => {
    const state = [...responseEvents(), { type: 'turn.completed' } as const]
      .reduce(reduceChatTurn, createInitialChatTurnState());

    expect(state.phase).toBe('complete');
    expect(state.content).toBe('Partial answer Final answer');
    expect(state.metadata.responseStops).toEqual(expectedStops);
    expect(state.metadata.stopReason).toBe('end_turn');
    expect(state.metadata.finishReason).toBe('stop');
    expect(state.metadata.stopSequence).toBeNull();
  });

  it('does not invent a raw provider stop reason when the provider omits it', () => {
    const events = mapProviderStreamChunk({ content: '', complete: true, toolCalls: [toolCall] });
    const completed = events.find(event => event.type === 'response.completed');
    expect(completed).toEqual({ type: 'response.completed', finishReason: 'tool_calls' });

    const state = events.reduce(reduceChatTurn, createInitialChatTurnState());
    expect(state.metadata.responseStops).toEqual([{ finishReason: 'tool_calls' }]);
    expect(state.metadata).not.toHaveProperty('stopReason');
    expect(state.metadata).not.toHaveProperty('stopSequence');
  });

  it('does not reuse an earlier raw reason when the next response only reports a normalized reason', () => {
    const events = [
      ...mapProviderStreamChunk({ content: '', complete: true, finishReason: 'length',
        metadata: { stopReason: 'max_tokens', stopSequence: 'old-sequence' } }),
      ...mapProviderStreamChunk({ content: 'Done', complete: true, finishReason: 'stop' }),
    ];
    const state = events.reduce(reduceChatTurn, createInitialChatTurnState());

    expect(state.metadata.responseStops).toEqual([
      { stopReason: 'max_tokens', stopSequence: 'old-sequence', finishReason: 'length' },
      { finishReason: 'stop' },
    ]);
    expect(state.metadata.finishReason).toBe('stop');
    expect(state.metadata).not.toHaveProperty('stopReason');
    expect(state.metadata).not.toHaveProperty('stopSequence');
  });

  it('retains raw stop metadata if an error arrives before the response completes', async () => {
    const chatService = createMockChatService();
    chatService.generateResponseStreaming.mockImplementation(streamOf([
      ...mapProviderStreamChunk({ content: '', complete: true, finishReason: 'tool_calls',
        metadata: { stopReason: 'tool_use', stopSequence: null } }),
      ...mapProviderStreamChunk({ content: '', complete: false,
        metadata: { stopReason: 'max_tokens', stopSequence: null } }),
      { type: 'turn.failed', error: { message: 'Provider stream error' } },
    ]));
    const handler = new MessageStreamHandler(chatService as unknown as ChatService, {
      onStreamingUpdate: jest.fn(), onToolCallsDetected: jest.fn(),
    });
    const current = conversation();

    await expect(handler.streamAndSave(current, 'Read and summarize', 'assistant-1', {}))
      .rejects.toThrow('Provider stream error');
    const assistant = current.messages.find(message => message.id === 'assistant-1');
    expect(assistant?.metadata?.stopReason).toBe('max_tokens');
    expect(assistant?.metadata?.stopSequence).toBeNull();
    expect(assistant?.metadata?.responseStops).toEqual([
      { stopReason: 'tool_use', stopSequence: null, finishReason: 'tool_calls' },
    ]);
    expect(assistant?.metadata).not.toHaveProperty('finishReason');
    expect(assistant?.state).toBe('invalid');
    expect(chatService.updateConversation).toHaveBeenCalledTimes(1);
  });

  it('saves the full stop history on the assistant message through streamAndSave', async () => {
    const chatService = createMockChatService();
    chatService.generateResponseStreaming.mockImplementation(streamOf([
      ...responseEvents(), { type: 'turn.completed' },
    ]));
    let serializedSave = '';
    chatService.updateConversation.mockImplementation(async saved => {
      serializedSave = JSON.stringify(saved);
    });
    const handler = new MessageStreamHandler(chatService as unknown as ChatService, {
      onStreamingUpdate: jest.fn(), onToolCallsDetected: jest.fn(),
    });

    const result = await handler.streamAndSave(conversation(), 'Read and summarize', 'assistant-1', {});
    const saved = JSON.parse(serializedSave) as ConversationData;
    const assistant = saved.messages.find(message => message.id === 'assistant-1');

    expect(chatService.updateConversation).toHaveBeenCalledTimes(1);
    expect(result.metadata?.responseStops).toEqual(expectedStops);
    expect(assistant?.state).toBe('complete');
    expect(assistant?.metadata?.responseStops).toEqual(expectedStops);
    expect(assistant?.metadata?.stopReason).toBe('end_turn');
    expect(assistant?.metadata?.stopSequence).toBeNull();
  });

  it.each([
    ['aborted', { type: 'turn.aborted', reason: 'user stopped' } as ChatRuntimeEvent],
    ['failed', { type: 'turn.failed', error: { message: 'network error' } } as ChatRuntimeEvent],
  ])('saves captured response stops when the turn is %s', async (terminalState, terminalEvent) => {
    const chatService = createMockChatService();
    chatService.generateResponseStreaming.mockImplementation(streamOf([
      { type: 'response.resolved', provider: 'anthropic', model: 'claude-haiku-5-5' },
      ...mapProviderStreamChunk({
        content: 'Partial', complete: true, finishReason: 'length',
        metadata: { stopReason: 'max_tokens', stopSequence: null },
      }),
      terminalEvent,
    ]));
    let serializedSave = '';
    chatService.updateConversation.mockImplementation(async saved => {
      serializedSave = JSON.stringify(saved);
    });
    const handler = new MessageStreamHandler(chatService as unknown as ChatService, {
      onStreamingUpdate: jest.fn(), onToolCallsDetected: jest.fn(),
    });

    await expect(handler.streamAndSave(conversation(), 'Read and summarize', 'assistant-1', {}))
      .rejects.toThrow();

    const saved = JSON.parse(serializedSave) as ConversationData;
    const assistant = saved.messages.find(message => message.id === 'assistant-1');
    expect(chatService.updateConversation).toHaveBeenCalledTimes(1);
    expect(assistant?.state).toBe(terminalState === 'aborted' ? 'aborted' : 'invalid');
    expect(assistant?.metadata?.responseStops).toEqual([{
      provider: 'anthropic', model: 'claude-haiku-5-5',
      stopReason: 'max_tokens', finishReason: 'length', stopSequence: null,
    }]);
  });

  it('persists the same stop history through StreamingResponseService terminal storage', async () => {
    const current = conversation();
    let serializedSave = '';
    const runtimeEvents = [...responseEvents(), { type: 'turn.completed' } as const];
    const dependencies = {
      llmService: {
        getDefaultModel: () => ({ provider: 'anthropic', model: 'claude-haiku-5-5' }),
        async *generateResponseStream() {
          for (const event of runtimeEvents) yield event;
        },
      },
      conversationService: {
        getConversation: jest.fn(async () => current),
        addMessage: jest.fn(async () => undefined),
        updateConversation: jest.fn(async (_id: string, update: { messages?: ConversationData['messages'] }) => {
          serializedSave = JSON.stringify(update);
        }),
      },
      toolCallService: {
        getAvailableTools: jest.fn(() => []),
        resetDetectedTools: jest.fn(),
        handleToolCallDetection: jest.fn(),
        fireToolEvent: jest.fn(),
      },
      costTrackingService: {
        createUsageCallback: jest.fn(() => jest.fn()),
        extractUsage: jest.fn(),
        trackMessageUsage: jest.fn(),
      },
    };
    const service = new StreamingResponseService(
      dependencies as unknown as ConstructorParameters<typeof StreamingResponseService>[0]
    );
    const emitted: ChatRuntimeEvent[] = [];
    for await (const envelope of service.generateResponse('conversation-1', 'Read and summarize', {
      provider: 'anthropic', model: 'claude-haiku-5-5', messageId: 'assistant-1',
    })) {
      emitted.push(envelope.event);
    }

    const saved = JSON.parse(serializedSave) as { messages: ConversationData['messages'] };
    const assistant = saved.messages.find(message => message.id === 'assistant-1');
    expect(emitted.at(-1)).toEqual({ type: 'turn.completed' });
    expect(dependencies.conversationService.updateConversation).toHaveBeenCalledTimes(1);
    expect(assistant?.metadata?.responseStops).toEqual(expectedStops);
    expect(assistant?.metadata?.stopReason).toBe('end_turn');
    expect(assistant?.metadata?.stopSequence).toBeNull();
  });
});
