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

/**
 * Build an async generator that yields the provided chunks, mimicking
 * ChatService.generateResponseStreaming.
 */
function streamOf(chunks: Array<Record<string, unknown>>) {
  return async function* () {
    for (const chunk of chunks) {
      yield chunk;
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
      streamOf([{ complete: true }])
    );

    await handler.streamResponse(conversation, 'hi', 'msg_ai', {});

    const aiMessage = conversation.messages.find(m => m.id === 'msg_ai');
    expect(aiMessage?.isLoading).toBe(false);
    expect(aiMessage?.state).toBe('complete');
    expect(aiMessage?.content).toBe('');
  });

  it('clears isLoading via the safety net when the stream ends without a complete chunk', async () => {
    const conversation = conversationWithLoadingPlaceholder();
    // No chunk has complete:true, so the loop exits and the post-loop safety
    // net must finalize the placeholder.
    mockChatService.generateResponseStreaming.mockImplementation(
      streamOf([])
    );

    await handler.streamResponse(conversation, 'hi', 'msg_ai', {});

    const aiMessage = conversation.messages.find(m => m.id === 'msg_ai');
    expect(aiMessage?.isLoading).toBe(false);
    expect(aiMessage?.state).toBe('complete');
  });

  it('still clears isLoading the normal way once a token streams', async () => {
    const conversation = conversationWithLoadingPlaceholder();
    mockChatService.generateResponseStreaming.mockImplementation(
      streamOf([{ chunk: 'Hello' }, { complete: true }])
    );

    const result = await handler.streamResponse(conversation, 'hi', 'msg_ai', {});

    const aiMessage = conversation.messages.find(m => m.id === 'msg_ai');
    expect(aiMessage?.isLoading).toBe(false);
    expect(aiMessage?.content).toBe('Hello');
    expect(result.streamedContent).toBe('Hello');
  });
});
