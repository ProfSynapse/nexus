/**
 * MessageAlternativeService Unit Tests
 *
 * Tests for the retry/alternative response generation service.
 * Bug #2: Retry was clearing toolCalls at start, losing original data.
 * Bug #3: After retry, activeAlternativeIndex was wrong (Object.assign overwrite).
 * Bug #8: No concurrent retry guard.
 * Bug #9: Retry cleared content instead of showing overlay.
 *
 * Key behaviors verified:
 * - Retry does NOT clear original tool calls
 * - Concurrent retry guard blocks second attempt
 * - Staging pattern does not mutate original conversation
 * - On success, branch is created via BranchManager
 * - On abort, original content is untouched
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

// Mock document.querySelector for setRetryOverlay
const mockClassList = {
  add: jest.fn(),
  remove: jest.fn()
};

// Minimal global document mock for overlay tests
Object.defineProperty(global, 'document', {
  value: {
    querySelector: jest.fn(() => ({
      classList: mockClassList
    }))
  },
  writable: true,
  configurable: true
});

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
  // Bug #2: Retry does NOT clear toolCalls
  // ==========================================================================

  describe('retry preserves original tool calls (Bug #2)', () => {
    it('should not mutate original message toolCalls during retry', async () => {
      const originalToolCalls = [
        createCompletedToolCall({ id: 'tc_orig_1' }),
        createCompletedToolCall({ id: 'tc_orig_2' })
      ];
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({
            id: 'msg_ai',
            toolCalls: originalToolCalls
          })
        ]
      });

      // Keep a reference to check it was not mutated
      const messageBeforeRetry = conversation.messages[1];
      const toolCallsBefore = [...messageBeforeRetry.toolCalls!];

      await service.createAlternativeResponse(conversation, 'msg_ai');

      // Original message tool calls should be untouched
      expect(messageBeforeRetry.toolCalls).toBeDefined();
      expect(messageBeforeRetry.toolCalls!.length).toBe(toolCallsBefore.length);
      expect(messageBeforeRetry.toolCalls!.map(tc => tc.id)).toEqual(
        toolCallsBefore.map(tc => tc.id)
      );
    });
  });

  // ==========================================================================
  // Bug #8: Concurrent retry guard
  // ==========================================================================

  describe('concurrent retry guard (Bug #8)', () => {
    it('should block second concurrent retry on the same message', async () => {
      // First retry takes time (streaming is async)
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
  // Staging pattern: no mutation of original conversation
  // ==========================================================================

  describe('staging pattern (Bug #3, #9)', () => {
    it('should create staging conversation clone for streaming', async () => {
      const originalContent = 'Original AI response with tool calls';
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({
            id: 'msg_ai',
            content: originalContent,
            toolCalls: TOOL_CALLS.allCompleted
          })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      // Verify streamResponse was called with a staging conversation
      const streamCall = mockStreamHandler.streamResponse.mock.calls[0];
      const stagingConversation = streamCall[0];

      // Staging should have the same number of messages
      expect(stagingConversation.messages.length).toBe(conversation.messages.length);

      // The staging AI message should have empty content (for fresh streaming)
      const stagingAiMsg = stagingConversation.messages[1];
      expect(stagingAiMsg.content).toBe('');
      expect(stagingAiMsg.state).toBe('draft');
      expect(stagingAiMsg.isLoading).toBe(true);
      expect(stagingAiMsg.toolCalls).toBeUndefined();
    });

    it('should not mutate original conversation messages during streaming', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({
            id: 'msg_ai',
            content: 'Original content',
            state: 'complete'
          })
        ]
      });

      const originalContent = conversation.messages[1].content;
      const originalState = conversation.messages[1].state;

      await service.createAlternativeResponse(conversation, 'msg_ai');

      // Original message should be unchanged
      expect(conversation.messages[1].content).toBe(originalContent);
      expect(conversation.messages[1].state).toBe(originalState);
    });
  });

  // ==========================================================================
  // Success path: branch creation
  // ==========================================================================

  describe('success path', () => {
    it('should create branch via BranchManager on successful stream', async () => {
      mockStreamHandler.streamResponse.mockResolvedValue({
        streamedContent: 'New alternative content',
        toolCalls: [createCompletedToolCall({ id: 'tc_new' })]
      });

      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'msg_user' }),
          createAssistantMessage({ id: 'msg_ai' })
        ]
      });

      await service.createAlternativeResponse(conversation, 'msg_ai');

      expect(mockBranchManager.createHumanBranch).toHaveBeenCalledWith(
        conversation,
        'msg_ai',
        expect.objectContaining({
          role: 'assistant',
          content: 'New alternative content',
          state: 'complete',
          toolCalls: expect.arrayContaining([
            expect.objectContaining({ id: 'tc_new' })
          ])
        })
      );
    });

    it('should fire onConversationUpdated after branch creation', async () => {
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
  });

  // ==========================================================================
  // Error path
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
      // Should fire conversation update (original untouched)
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
