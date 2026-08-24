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

    expect(onReasoningUpdate).toHaveBeenLastCalledWith('msg_ai', 'Think', true);
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
});
