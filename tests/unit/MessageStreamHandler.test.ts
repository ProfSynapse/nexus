/**
 * MessageStreamHandler Unit Tests
 *
 * Regression coverage for issue #271, claim b: a stream that completes (or
 * exits) WITHOUT ever emitting a token must clear the assistant placeholder's
 * isLoading flag. Pre-fix, isLoading was only cleared on the first token
 * (inside `if (chunk.chunk)`), so an empty completion left the chat spinner
 * stuck forever. The spinner is driven by `message.isLoading && !content` in
 * MessageBubble, so leaving isLoading:true on an empty message spins endlessly.
 */

import { MessageStreamHandler, StreamHandlerEvents } from '../../src/ui/chat/services/MessageStreamHandler';
import { createConversation, createUserMessage, createAssistantMessage } from '../fixtures/chatBugs';
import { createMockChatService } from '../mocks/chatService';
import { ChatService } from '../../src/services/chat/ChatService';
import { ConversationData } from '../../src/types/chat/ChatTypes';
import type { ChatRuntimeEvent } from '../../src/services/llm/runtime/ChatRuntimeEvent';

/**
 * Build an async generator that yields the provided chunks, mimicking
 * ChatService.generateResponseStreaming.
 */
function streamOf(events: ChatRuntimeEvent[]) {
  return async function* () {
    for (const event of events) {
      yield { messageId: 'msg_ai', event };
    }
  };
}

function conversationWithLoadingPlaceholder(): ConversationData {
  return createConversation({
    messages: [
      createUserMessage({ id: 'msg_user', content: 'hi' }),
      createAssistantMessage({
        id: 'msg_ai',
        content: '',
        isLoading: true,
        state: 'draft'
      })
    ]
  });
}

describe('MessageStreamHandler - isLoading clearing (issue #271 claim b)', () => {
  let handler: MessageStreamHandler;
  let mockChatService: ReturnType<typeof createMockChatService>;
  let events: StreamHandlerEvents;

  beforeEach(() => {
    mockChatService = createMockChatService();
    events = {
      onStreamingUpdate: jest.fn(),
      onToolCallsDetected: jest.fn()
    };
    handler = new MessageStreamHandler(mockChatService as unknown as ChatService, events);
  });

  it('passes the live dialog callback and abort signal into the stream', async () => {
    const conversation = conversationWithLoadingPlaceholder();
    const controller = new AbortController();
    const onToolLimitReached = jest.fn(async () => true);
    events.onToolLimitReached = onToolLimitReached;
    mockChatService.generateResponseStreaming.mockImplementation(
      streamOf([{ type: 'turn.completed' }])
    );

    await handler.streamResponse(conversation, 'hi', 'msg_ai', {
      abortSignal: controller.signal
    });

    expect(mockChatService.generateResponseStreaming).toHaveBeenCalledWith(
      conversation.id,
      'hi',
      expect.objectContaining({
        messageId: 'msg_ai',
        abortSignal: controller.signal,
        onToolLimitReached
      })
    );
  });

  it('clears isLoading on an empty-complete stream (no token ever streamed)', async () => {
    const conversation = conversationWithLoadingPlaceholder();
    mockChatService.generateResponseStreaming.mockImplementation(
      streamOf([{ type: 'turn.completed' }])
    );

    await handler.streamResponse(conversation, 'hi', 'msg_ai', {});

    const aiMessage = conversation.messages.find(m => m.id === 'msg_ai');
    expect(aiMessage?.isLoading).toBe(false);
    expect(aiMessage?.state).toBe('complete');
    expect(aiMessage?.content).toBe('');
  });

  it('rejects a producer that ends without an explicit terminal event', async () => {
    const conversation = conversationWithLoadingPlaceholder();
    // No chunk has complete:true, so the loop exits and the post-loop safety
    // net must finalize the placeholder.
    mockChatService.generateResponseStreaming.mockImplementation(
      streamOf([])
    );

    await expect(handler.streamResponse(conversation, 'hi', 'msg_ai', {}))
      .rejects.toThrow('without a terminal turn event');

    const aiMessage = conversation.messages.find(m => m.id === 'msg_ai');
    expect(aiMessage?.isLoading).toBe(true);
    expect(aiMessage?.state).toBe('draft');
  });

  it('still clears isLoading the normal way once a token streams', async () => {
    const conversation = conversationWithLoadingPlaceholder();
    mockChatService.generateResponseStreaming.mockImplementation(
      streamOf([
        { type: 'assistant.delta', text: 'Hello' },
        { type: 'turn.completed' },
      ])
    );

    const result = await handler.streamResponse(conversation, 'hi', 'msg_ai', {});

    const aiMessage = conversation.messages.find(m => m.id === 'msg_ai');
    expect(aiMessage?.isLoading).toBe(false);
    expect(aiMessage?.content).toBe('Hello');
    expect(result.streamedContent).toBe('Hello');
  });

  it('preserves reasoning, zero usage, metadata, provider, model, and cost through the reducer', async () => {
    const conversation = conversationWithLoadingPlaceholder();
    const onReasoningUpdate = jest.fn();
    events.onReasoningUpdate = onReasoningUpdate;
    mockChatService.generateResponseStreaming.mockImplementation(
      streamOf([
        { type: 'reasoning.delta', text: 'Think' },
        { type: 'assistant.delta', text: 'Answer' },
        { type: 'reasoning.completed' },
        { type: 'usage.updated', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
        { type: 'response.metadata', metadata: { responseId: 'response-1', zero: 0 } },
        { type: 'response.resolved', provider: 'openai', model: 'gpt-test' },
        { type: 'cost.updated', cost: { totalCost: 0, currency: 'USD' } },
        { type: 'turn.completed' },
      ])
    );

    const result = await handler.streamResponse(conversation, 'hi', 'msg_ai', {});
    const aiMessage = conversation.messages.find(m => m.id === 'msg_ai');

    expect(onReasoningUpdate).toHaveBeenLastCalledWith('msg_ai', 'Think', true, [
      { text: 'Think', contentOffset: 0 },
    ]);
    expect(aiMessage?.reasoning).toBe('Think');
    expect(aiMessage?.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    expect(aiMessage?.metadata).toEqual({ responseId: 'response-1', zero: 0 });
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-test');
    expect(result.cost).toEqual({ totalCost: 0, currency: 'USD' });
  });

  it('does not treat an intermediate tool boundary as the terminal turn', async () => {
    const conversation = conversationWithLoadingPlaceholder();
    const pendingToolCall = {
      id: 'call-1',
      type: 'function',
      function: { name: 'content_read', arguments: '{"path":"note.md"}' }
    };
    const completedToolCall = {
      ...pendingToolCall,
      result: { content: 'note' },
      success: true
    };
    mockChatService.generateResponseStreaming.mockImplementation(
      streamOf([
        { type: 'tool.snapshot', calls: [pendingToolCall], ready: true },
        { type: 'response.completed', finishReason: 'tool_calls' },
        { type: 'tool.execution.completed', operationId: 'call-1', call: completedToolCall, success: true },
        { type: 'assistant.delta', text: 'Done' },
        { type: 'turn.completed' },
      ])
    );

    const result = await handler.streamResponse(conversation, 'read it', 'msg_ai', {});

    expect(result.streamedContent).toBe('Done');
    expect(result.toolCalls?.[0].success).toBe(true);
    expect(events.onStreamingUpdate).toHaveBeenCalledWith('msg_ai', 'Done', false, true);
    expect(events.onStreamingUpdate).toHaveBeenLastCalledWith('msg_ai', 'Done', true, false);
  });

  it('updates the visible conversation total on each cost event before tool execution ends', async () => {
    const conversation = conversationWithLoadingPlaceholder();
    conversation.cost = { totalCost: 0.1, currency: 'USD' };
    const visibleTotals: number[] = [];
    events.onCostUpdate = () => visibleTotals.push(conversation.cost?.totalCost ?? 0);
    mockChatService.generateResponseStreaming.mockImplementation(streamOf([
      { type: 'cost.updated', cost: { totalCost: 0.02, currency: 'USD' } },
      { type: 'tool.execution.started', operationId: 'tool', call: { id: 'tool', type: 'function', function: { name: 'test', arguments: '{}' } } },
      { type: 'cost.updated', cost: { totalCost: 0.03, currency: 'USD' } },
      { type: 'turn.completed' },
    ]));

    await handler.streamResponse(conversation, 'hi', 'msg_ai', {});

    expect(visibleTotals[0]).toBeCloseTo(0.12);
    expect(visibleTotals[1]).toBeCloseTo(0.13);
    expect(conversation.messages.find(m => m.id === 'msg_ai')?.cost?.totalCost).toBeCloseTo(0.03);
  });

  it('does not overwrite a delayed provider charge with its stale final UI snapshot', async () => {
    const conversation = conversationWithLoadingPlaceholder();
    const persisted = conversationWithLoadingPlaceholder();
    const persistedMessage = persisted.messages.find(message => message.id === 'msg_ai')!;
    mockChatService.generateResponseStreaming.mockImplementation(async function* () {
      yield { messageId: 'msg_ai', event: { type: 'usage.updated' as const, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } } };
      yield { messageId: 'msg_ai', event: { type: 'cost.updated' as const, cost: { totalCost: 0.02, currency: 'USD' } } };
      yield { messageId: 'msg_ai', event: { type: 'assistant.delta' as const, text: 'done' } };
      persistedMessage.content = 'done';
      persistedMessage.state = 'complete';
      persistedMessage.usage = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
      persistedMessage.cost = { totalCost: 0.02, currency: 'USD' };
      persisted.cost = { totalCost: 0.02, currency: 'USD' };
      yield { messageId: 'msg_ai', event: { type: 'turn.completed' as const } };
    });
    mockChatService.updateConversation.mockImplementation(async (next: ConversationData) => {
      persisted.messages = structuredClone(next.messages);
      return { success: true };
    });

    // The provider's charge arrives after its generator closes, before the UI
    // caller returns. A second save of the earlier UI snapshot loses it.
    const originalStream = mockChatService.generateResponseStreaming.getMockImplementation()!;
    mockChatService.generateResponseStreaming.mockImplementation(async function* (...args) {
      try {
        yield* originalStream(...args);
      } finally {
        persistedMessage.cost = { totalCost: 0.05, currency: 'USD' };
        persistedMessage.usage = { promptTokens: 300, completionTokens: 30, totalTokens: 330 };
        persisted.cost = { totalCost: 0.05, currency: 'USD' };
      }
    });

    await handler.streamAndSave(conversation, 'hi', 'msg_ai', {});

    expect(persisted.messages.find(message => message.id === 'msg_ai')?.cost?.totalCost).toBeCloseTo(0.05);
    expect(persisted.messages.find(message => message.id === 'msg_ai')?.usage?.promptTokens).toBe(300);
    expect(mockChatService.updateConversation).not.toHaveBeenCalled();
  });

  it('saves a partial message only when the stream fails before a persisted terminal event', async () => {
    const conversation = conversationWithLoadingPlaceholder();
    mockChatService.generateResponseStreaming.mockImplementation(async function* () {
      yield { messageId: 'msg_ai', event: { type: 'assistant.delta' as const, text: 'partial' } };
      throw new Error('connection lost');
    });

    await expect(handler.streamAndSave(conversation, 'hi', 'msg_ai', {})).rejects.toThrow('connection lost');

    expect(mockChatService.updateConversation).toHaveBeenCalledTimes(1);
    expect(conversation.messages.find(message => message.id === 'msg_ai')?.content).toBe('partial');
  });

  it('does not save a stale UI snapshot after a persisted failed terminal event', async () => {
    const conversation = conversationWithLoadingPlaceholder();
    mockChatService.generateResponseStreaming.mockImplementation(streamOf([
      { type: 'assistant.delta', text: 'partial' },
      { type: 'turn.failed', error: { message: 'provider failed' } },
    ]));

    await expect(handler.streamAndSave(conversation, 'hi', 'msg_ai', {})).rejects.toThrow('provider failed');

    expect(mockChatService.updateConversation).not.toHaveBeenCalled();
    expect(conversation.messages.find(message => message.id === 'msg_ai')?.state).toBe('invalid');
  });
});
