/**
 * MessageAlternativeService Unit Tests
 *
 * Tests for the retry/alternative response generation service.
 *
 * Key behaviors verified:
 * - Original content is saved to a branch BEFORE clearing the message
 * - Message content is cleared and set to loading state before streaming
 * - Streaming happens directly into the live conversation (not a staging clone)
 * - On success, message has new content, branch has old content
 * - On abort, partial content is kept (original safe in branch)
 * - Concurrent retry guard blocks second attempt
 * - Branch arrows allow navigation between new (current) and old (branch)
 */

import { MessageAlternativeService } from '../../src/ui/chat/services/MessageAlternativeService';
import {
  createConversation,
  createUserMessage,
  createAssistantMessage,
  createCompletedToolCall,
  TOOL_CALLS
} from '../fixtures/chatBugs';
import {
  createMockChatService,
  createMockBranchManager,
  createMockStreamHandler,
  createMockAbortHandler
} from '../mocks/chatService';

describe('MessageAlternativeService', () => {
  let service: MessageAlternativeService;
  let mockChatService: ReturnType<typeof createMockChatService>;
  let mockBranchManager: ReturnType<typeof createMockBranchManager>;
  let mockStreamHandler: ReturnType<typeof createMockStreamHandler>;
  let mockAbortHandler: ReturnType<typeof createMockAbortHandler>;
  let mockEvents: {
    onStreamingUpdate: jest.Mock;
    onConversationUpdated: jest.Mock;
    onToolCallsDetected: jest.Mock;
    onLoadingStateChanged: jest.Mock;
    onError: jest.Mock;
  };

  beforeEach(() => {
    mockChatService = createMockChatService();
    mockBranchManager = createMockBranchManager();
    mockStreamHandler = createMockStreamHandler();
    mockAbortHandler = createMockAbortHandler();
    mockEvents = {
      onStreamingUpdate: jest.fn(),
      onConversationUpdated: jest.fn(),
      onToolCallsDetected: jest.fn(),
      onLoadingStateChanged: jest.fn(),
      onError: jest.fn()
    };

    service = new MessageAlternativeService(
      mockChatService as any,
      mockBranchManager as any,
      mockStreamHandler as any,
      mockAbortHandler as any,
      mockEvents
    );

    jest.clearAllMocks();
  });

  // ==========================================================================
  // Branch creation: original content preserved in branch
  // ==========================================================================

  describe('branch creation preserves original content', () => {
    it('should create a branch with original content BEFORE clearing message', async () => {
      const originalContent = 'Original AI response';
      const originalToolCalls = [
        createCompletedToolCall({ id: 'tc_orig_1' }),
        createCompletedToolCall({ id: 'tc_orig_2' })
      ];
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({
            id: 'msg_ai',
            content: originalContent,
            toolCalls: originalToolCalls,
            reasoning: 'Some reasoning'
          })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      // Branch should be created with original content
      expect(mockBranchManager.createHumanBranch).toHaveBeenCalledWith(
        conversation,
        'msg_ai',
        expect.objectContaining({
          role: 'assistant',
          content: originalContent,
          toolCalls: expect.arrayContaining([
            expect.objectContaining({ id: 'tc_orig_1' }),
            expect.objectContaining({ id: 'tc_orig_2' })
          ]),
          reasoning: 'Some reasoning'
        })
      );
    });

    it('should create branch before calling streamResponse', async () => {
      const callOrder: string[] = [];

      mockBranchManager.createHumanBranch = jest.fn(async () => {
        callOrder.push('createBranch');
        return 'branch_new';
      });

      mockStreamHandler.streamResponse = jest.fn(async () => {
        callOrder.push('streamResponse');
        return { streamedContent: 'New content', toolCalls: undefined };
      });

      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      expect(callOrder).toEqual(['createBranch', 'streamResponse']);
    });
  });

  // ==========================================================================
  // Message clearing: content cleared for fresh streaming
  // ==========================================================================

  describe('message clearing before streaming', () => {
    it('should clear message content and set loading state before streaming', async () => {
      let capturedMessageState: any = null;

      mockStreamHandler.streamResponse = jest.fn(async (conv) => {
        // Capture the message state when streaming starts
        const aiMsg = conv.messages.find((m: any) => m.id === 'msg_ai');
        capturedMessageState = {
          content: aiMsg?.content,
          toolCalls: aiMsg?.toolCalls,
          reasoning: aiMsg?.reasoning,
          isLoading: aiMsg?.isLoading,
          state: aiMsg?.state
        };
        return { streamedContent: 'New content', toolCalls: undefined };
      });

      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({
            id: 'msg_ai',
            content: 'Original content',
            toolCalls: TOOL_CALLS.allCompleted,
            reasoning: 'Original reasoning'
          })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      // At the time of streaming, message should be cleared
      expect(capturedMessageState).toEqual({
        content: '',
        toolCalls: undefined,
        reasoning: undefined,
        isLoading: true,
        state: 'draft'
      });
    });

    it('should fire onConversationUpdated before streaming starts', async () => {
      let conversationUpdateCount = 0;

      mockEvents.onConversationUpdated = jest.fn(() => {
        conversationUpdateCount++;
      });

      mockStreamHandler.streamResponse = jest.fn(async () => {
        // At this point, one update should have fired (cleared state)
        expect(conversationUpdateCount).toBe(1);
        return { streamedContent: 'New content', toolCalls: undefined };
      });

      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      // Total: 1 before streaming + 1 after completion
      expect(mockEvents.onConversationUpdated).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Streaming: streams into live conversation (not a staging clone)
  // ==========================================================================

  describe('live streaming (no staging clone)', () => {
    it('should pass the live conversation to streamResponse', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      const streamCall = mockStreamHandler.streamResponse.mock.calls[0];
      const passedConversation = streamCall[0];

      // Should be the same object reference (not a clone)
      expect(passedConversation).toBe(conversation);
    });

    it('should pass user message content to streamResponse', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user', content: 'Tell me about testing' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      const streamCall = mockStreamHandler.streamResponse.mock.calls[0];
      const passedUserContent = streamCall[1];

      expect(passedUserContent).toBe('Tell me about testing');
    });

    it('should pass abort signal to streamResponse', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      const streamCall = mockStreamHandler.streamResponse.mock.calls[0];
      const streamOptions = streamCall[3];

      expect(streamOptions.abortSignal).toBeDefined();
      expect(streamOptions.abortSignal).toBeInstanceOf(AbortSignal);
    });
  });

  // ==========================================================================
  // Concurrent retry guard
  // ==========================================================================

  describe('concurrent retry guard', () => {
    it('should block second concurrent retry on the same message', async () => {
      let resolveStream: (value: any) => void;
      mockStreamHandler.streamResponse = jest.fn(
        () => new Promise(resolve => { resolveStream = resolve; })
      );

      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      // Start first retry (will be pending)
      const firstRetry = service.createAlternativeResponse(conversation, 'msg_ai');

      // Immediately try second retry on same message
      await service.createAlternativeResponse(conversation, 'msg_ai');

      // Only one streamResponse call should have been made
      expect(mockStreamHandler.streamResponse).toHaveBeenCalledTimes(1);

      // Clean up - resolve the first stream
      resolveStream!({ streamedContent: 'done', toolCalls: undefined });
      await firstRetry;
    });

    it('should allow retry after previous completes', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      // First retry completes
      await service.createAlternativeResponse(conversation, 'msg_ai');

      // Reset mock to track second call
      mockStreamHandler.streamResponse.mockClear();

      // Second retry should proceed
      await service.createAlternativeResponse(conversation, 'msg_ai');

      expect(mockStreamHandler.streamResponse).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Success path
  // ==========================================================================

  describe('success path', () => {
    it('should save conversation after streaming completes', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      expect(mockChatService.updateConversation).toHaveBeenCalledWith(conversation);
    });

    it('should fire onConversationUpdated after streaming completes', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      expect(mockEvents.onConversationUpdated).toHaveBeenCalledWith(conversation);
    });

    it('should set loading state correctly during lifecycle', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      // Loading should have been set to true at start, false at end
      expect(mockEvents.onLoadingStateChanged).toHaveBeenCalledWith(true);
      expect(mockEvents.onLoadingStateChanged).toHaveBeenCalledWith(false);
    });

    it('should set activeAlternativeIndex to 0 (show current/new content)', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      // After retry, the message itself has new content (index 0)
      // The old content is in the branch (index 1+)
      expect(conversation.messages[1].activeAlternativeIndex).toBe(0);
    });
  });

  // ==========================================================================
  // Error handling
  // ==========================================================================

  describe('error handling', () => {
    it('should fire onError for non-abort errors', async () => {
      mockStreamHandler.streamResponse.mockRejectedValue(new Error('Network failure'));

      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      expect(mockEvents.onError).toHaveBeenCalledWith('Failed to generate alternative response');
    });

    it('should not fire onError for abort errors', async () => {
      const abortError = Object.assign(new Error('Aborted'), { name: 'AbortError' });
      mockStreamHandler.streamResponse.mockRejectedValue(abortError);

      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      expect(mockEvents.onError).not.toHaveBeenCalled();
    });

    it('should keep partial content on abort and save conversation', async () => {
      const abortError = Object.assign(new Error('Aborted'), { name: 'AbortError' });

      // Simulate: streamResponse clears message (our code does this),
      // then starts streaming and writes partial content before aborting
      mockStreamHandler.streamResponse = jest.fn(async (conv) => {
        // Simulate partial content written during streaming
        const aiMsg = conv.messages.find((m: any) => m.id === 'msg_ai');
        if (aiMsg) {
          aiMsg.content = 'Partial streamed content';
          aiMsg.state = 'streaming';
        }
        throw abortError;
      });

      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai', content: 'Original content' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      // Message should have partial content preserved
      const aiMsg = conversation.messages[1];
      expect(aiMsg.state).toBe('aborted');
      expect(aiMsg.isLoading).toBe(false);

      // Conversation should be saved
      expect(mockChatService.updateConversation).toHaveBeenCalledWith(conversation);

      // UI should be updated
      expect(mockEvents.onConversationUpdated).toHaveBeenCalledWith(conversation);
    });

    it('should clear retry guard on error', async () => {
      mockStreamHandler.streamResponse.mockRejectedValue(new Error('Failure'));

      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      // Should be able to retry again (guard cleared)
      mockStreamHandler.streamResponse.mockResolvedValue({
        streamedContent: 'Success now',
        toolCalls: undefined
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      // Two stream calls total (first failed, second succeeded)
      expect(mockStreamHandler.streamResponse).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Validation: early returns
  // ==========================================================================

  describe('validation', () => {
    it('should return early if message is not found', async () => {
      const conversation = createConversation();

      await service.createAlternativeResponse(conversation, 'nonexistent');

      expect(mockStreamHandler.streamResponse).not.toHaveBeenCalled();
    });

    it('should return early if message is not assistant role', async () => {
      const conversation = createConversation();

      await service.createAlternativeResponse(conversation, conversation.messages[0].id);

      expect(mockStreamHandler.streamResponse).not.toHaveBeenCalled();
    });

    it('should return early if AI message is the first message (no user prompt)', async () => {
      const conversation = createConversation({
        messages: [createAssistantMessage({ id: 'msg_first' })]
      });

      await service.createAlternativeResponse(conversation, 'msg_first');

      expect(mockStreamHandler.streamResponse).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // cancel and isGenerating
  // ==========================================================================

  describe('cancel and isGenerating', () => {
    it('should report not generating initially', () => {
      expect(service.isGenerating()).toBe(false);
    });

    it('should cancel without error when not generating', () => {
      expect(() => service.cancel()).not.toThrow();
    });
  });
});
