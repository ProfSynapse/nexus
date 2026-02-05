/**
 * AbortHandler Unit Tests
 *
 * Tests for the unified abort handling utility.
 * Bug #1: Stop button was wiping all tool calls instead of preserving completed ones.
 *
 * Key behaviors verified:
 * - Completed tool calls are preserved on abort
 * - Empty messages are deleted
 * - Messages with partial content are kept with cleaned-up tool calls
 */

import { AbortHandler, AbortHandlerEvents } from '../../src/ui/chat/utils/AbortHandler';
import {
  createConversation,
  createUserMessage,
  createAssistantMessage,
  createStreamingMessage,
  TOOL_CALLS,
  createCompletedToolCall,
  createIncompleteToolCall
} from '../fixtures/chatBugs';
import { createMockChatService } from '../mocks/chatService';

describe('AbortHandler', () => {
  let handler: AbortHandler;
  let mockChatService: ReturnType<typeof createMockChatService>;
  let events: AbortHandlerEvents;

  beforeEach(() => {
    mockChatService = createMockChatService();
    events = {
      onStreamingUpdate: jest.fn(),
      onConversationUpdated: jest.fn()
    };
    handler = new AbortHandler(mockChatService as any, events);
  });

  // ==========================================================================
  // handleAbort: Message with content
  // ==========================================================================

  describe('handleAbort - message with content', () => {
    it('should preserve completed tool calls and remove incomplete ones', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage(),
          createAssistantMessage({
            id: 'msg_ai',
            content: 'Found results',
            toolCalls: TOOL_CALLS.mixed,
            isLoading: true,
            state: 'streaming'
          })
        ]
      });

      await handler.handleAbort(conversation, 'msg_ai');

      const aiMessage = conversation.messages.find(m => m.id === 'msg_ai')!;

      // Should only keep completed tool calls (those with result or success defined)
      expect(aiMessage.toolCalls).toBeDefined();
      expect(aiMessage.toolCalls!.length).toBe(2); // tc_mix_c1 and tc_mix_c2
      expect(aiMessage.toolCalls!.every(tc => tc.result !== undefined || tc.success !== undefined)).toBe(true);
    });

    it('should set tool calls to undefined when all are incomplete', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage(),
          createAssistantMessage({
            id: 'msg_ai',
            content: 'Some content',
            toolCalls: TOOL_CALLS.allIncomplete,
            isLoading: true
          })
        ]
      });

      await handler.handleAbort(conversation, 'msg_ai');

      const aiMessage = conversation.messages.find(m => m.id === 'msg_ai')!;
      expect(aiMessage.toolCalls).toBeUndefined();
    });

    it('should mark message as aborted and not loading', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage(),
          createAssistantMessage({
            id: 'msg_ai',
            content: 'Some content',
            isLoading: true,
            state: 'streaming'
          })
        ]
      });

      await handler.handleAbort(conversation, 'msg_ai');

      const aiMessage = conversation.messages.find(m => m.id === 'msg_ai')!;
      expect(aiMessage.state).toBe('aborted');
      expect(aiMessage.isLoading).toBe(false);
    });

    it('should save conversation and fire streaming + conversation events', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage(),
          createAssistantMessage({
            id: 'msg_ai',
            content: 'Partial content',
            isLoading: true
          })
        ]
      });

      await handler.handleAbort(conversation, 'msg_ai');

      expect(mockChatService.updateConversation).toHaveBeenCalledWith(conversation);
      expect(events.onStreamingUpdate).toHaveBeenCalledWith('msg_ai', 'Partial content', true, false);
      expect(events.onConversationUpdated).toHaveBeenCalledWith(conversation);
    });
  });

  // ==========================================================================
  // handleAbort: Message without content
  // ==========================================================================

  describe('handleAbort - message without content', () => {
    it('should delete empty message from conversation', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage(),
          createAssistantMessage({
            id: 'msg_empty',
            content: '',
            isLoading: true,
            state: 'streaming'
          })
        ]
      });

      await handler.handleAbort(conversation, 'msg_empty');

      // Message should be removed from the array
      expect(conversation.messages.length).toBe(1);
      expect(conversation.messages[0].role).toBe('user');
    });

    it('should delete whitespace-only message from conversation', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage(),
          createAssistantMessage({
            id: 'msg_whitespace',
            content: '   \n  ',
            isLoading: true
          })
        ]
      });

      await handler.handleAbort(conversation, 'msg_whitespace');

      expect(conversation.messages.length).toBe(1);
    });

    it('should save and update UI after deleting empty message', async () => {
      const conversation = createConversation({
        messages: [
          createUserMessage(),
          createAssistantMessage({
            id: 'msg_empty',
            content: '',
            isLoading: true
          })
        ]
      });

      await handler.handleAbort(conversation, 'msg_empty');

      expect(mockChatService.updateConversation).toHaveBeenCalled();
      expect(events.onConversationUpdated).toHaveBeenCalled();
      // Should NOT fire streaming update for empty message
      expect(events.onStreamingUpdate).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // handleAbort: Edge cases
  // ==========================================================================

  describe('handleAbort - edge cases', () => {
    it('should no-op when aiMessageId is null', async () => {
      const conversation = createConversation();

      await handler.handleAbort(conversation, null);

      expect(mockChatService.updateConversation).not.toHaveBeenCalled();
    });

    it('should no-op when message is not found in conversation', async () => {
      const conversation = createConversation();

      await handler.handleAbort(conversation, 'nonexistent_id');

      expect(mockChatService.updateConversation).not.toHaveBeenCalled();
    });

    it('should use custom handler when provided', async () => {
      const customHandler = jest.fn();
      const conversation = createConversation({
        messages: [
          createUserMessage(),
          createAssistantMessage({ id: 'msg_ai', content: 'Content' })
        ]
      });

      await handler.handleAbort(conversation, 'msg_ai', customHandler);

      expect(customHandler).toHaveBeenCalledWith(true, expect.objectContaining({ id: 'msg_ai' }));
      // Default handling should NOT run
      expect(mockChatService.updateConversation).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // isAbortError
  // ==========================================================================

  describe('isAbortError', () => {
    it('should return true for AbortError', () => {
      const error = Object.assign(new Error('Aborted'), { name: 'AbortError' });
      expect(handler.isAbortError(error)).toBe(true);
    });

    it('should return false for regular Error', () => {
      const error = new Error('Something went wrong');
      expect(handler.isAbortError(error)).toBe(false);
    });

    it('should return false for non-Error values', () => {
      expect(handler.isAbortError('string error')).toBe(false);
      expect(handler.isAbortError(null)).toBe(false);
      expect(handler.isAbortError(undefined)).toBe(false);
    });
  });

  // ==========================================================================
  // handleIfAbortError
  // ==========================================================================

  describe('handleIfAbortError', () => {
    it('should handle abort error and return true', async () => {
      const error = Object.assign(new Error('Aborted'), { name: 'AbortError' });
      const conversation = createConversation({
        messages: [
          createUserMessage(),
          createAssistantMessage({ id: 'msg_ai', content: 'Content' })
        ]
      });

      const result = await handler.handleIfAbortError(error, conversation, 'msg_ai');

      expect(result).toBe(true);
      expect(mockChatService.updateConversation).toHaveBeenCalled();
    });

    it('should return false for non-abort error without handling', async () => {
      const error = new Error('Network error');
      const conversation = createConversation();

      const result = await handler.handleIfAbortError(error, conversation, 'msg_ai');

      expect(result).toBe(false);
      expect(mockChatService.updateConversation).not.toHaveBeenCalled();
    });
  });
});
