/**
 * ConversationEmbeddingWatcher Unit Tests
 *
 * Tests the real-time watcher that embeds completed assistant messages
 * as QA pairs. Uses mocked dependencies for isolation.
 */

import { ConversationEmbeddingWatcher } from '../../src/services/embeddings/ConversationEmbeddingWatcher';
import type { EmbeddingService } from '../../src/services/embeddings/EmbeddingService';
import type { MessageRepository } from '../../src/database/repositories/MessageRepository';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import type { MessageData } from '../../src/types/storage/HybridStorageTypes';
import { createMessage, resetMessageIdCounter } from '../fixtures/conversationSearch';

// ============================================================================
// Mock Factory
// ============================================================================

type OnMessageCompleteCallback = (message: MessageData) => void;

function createMockDependencies() {
  let registeredCallback: OnMessageCompleteCallback | null = null;

  const mockEmbeddingService = {
    embedConversationTurn: jest.fn().mockResolvedValue(undefined),
  };

  const mockMessageRepository = {
    onMessageComplete: jest.fn((callback: OnMessageCompleteCallback) => {
      registeredCallback = callback;
      return () => {
        registeredCallback = null;
      };
    }),
    getMessagesBySequenceRange: jest.fn().mockResolvedValue([]),
  };

  const mockDb = {
    queryOne: jest.fn().mockResolvedValue(null),
  };

  return {
    mockEmbeddingService,
    mockMessageRepository,
    mockDb,
    getRegisteredCallback: () => registeredCallback,
    triggerMessageComplete: (message: MessageData) => {
      if (registeredCallback) {
        registeredCallback(message);
      }
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ConversationEmbeddingWatcher', () => {
  let watcher: ConversationEmbeddingWatcher;
  let mocks: ReturnType<typeof createMockDependencies>;

  beforeEach(() => {
    resetMessageIdCounter();
    mocks = createMockDependencies();
    watcher = new ConversationEmbeddingWatcher(
      mocks.mockEmbeddingService as jest.Mocked<EmbeddingService>,
      mocks.mockMessageRepository as jest.Mocked<MessageRepository>,
      mocks.mockDb as jest.Mocked<SQLiteCacheManager>
    );
  });

  afterEach(() => {
    watcher.stop();
  });

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  describe('lifecycle', () => {
    it('should register callback on start', () => {
      watcher.start();
      expect(mocks.mockMessageRepository.onMessageComplete).toHaveBeenCalledTimes(1);
      expect(mocks.getRegisteredCallback()).not.toBeNull();
    });

    it('should not register multiple callbacks on repeated start calls', () => {
      watcher.start();
      watcher.start();
      watcher.start();
      expect(mocks.mockMessageRepository.onMessageComplete).toHaveBeenCalledTimes(1);
    });

    it('should unregister callback on stop', () => {
      watcher.start();
      expect(mocks.getRegisteredCallback()).not.toBeNull();

      watcher.stop();
      expect(mocks.getRegisteredCallback()).toBeNull();
    });

    it('should be safe to call stop multiple times', () => {
      watcher.start();
      watcher.stop();
      watcher.stop();
      watcher.stop();
      // No error thrown
      expect(mocks.getRegisteredCallback()).toBeNull();
    });

    it('should be safe to call stop without start', () => {
      watcher.stop(); // No error
      expect(mocks.getRegisteredCallback()).toBeNull();
    });
  });

  // ==========================================================================
  // Embeds Complete Assistant Messages
  // ==========================================================================

  describe('embedding complete assistant messages', () => {
    it('should embed a complete assistant message with preceding user message', async () => {
      // Set up: user message found when looking backwards
      const userMessage = createMessage({
        id: 'msg-user-1',
        conversationId: 'conv-embed-001',
        role: 'user',
        content: 'How does the Obsidian API work?',
        sequenceNumber: 0,
      });

      mocks.mockMessageRepository.getMessagesBySequenceRange.mockResolvedValue([userMessage]);
      mocks.mockDb.queryOne
        // First call: isConversationBranch check
        .mockResolvedValueOnce({ metadataJson: '{}' })
        // Second call: conversation metadata (workspace/session)
        .mockResolvedValueOnce({ workspaceId: 'ws-1', sessionId: 'sess-1' });

      watcher.start();

      const assistantMessage = createMessage({
        id: 'msg-asst-1',
        conversationId: 'conv-embed-001',
        role: 'assistant',
        content: 'The Obsidian API provides methods for vault operations, UI components, and event handling.',
        sequenceNumber: 1,
        state: 'complete',
      });

      // Trigger the callback
      mocks.triggerMessageComplete(assistantMessage);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mocks.mockEmbeddingService.embedConversationTurn).toHaveBeenCalledTimes(1);

      const embeddedPair = mocks.mockEmbeddingService.embedConversationTurn.mock.calls[0][0];
      expect(embeddedPair.pairType).toBe('conversation_turn');
      expect(embeddedPair.question).toBe('How does the Obsidian API work?');
      expect(embeddedPair.answer).toContain('vault operations');
      expect(embeddedPair.conversationId).toBe('conv-embed-001');
      expect(embeddedPair.workspaceId).toBe('ws-1');
      expect(embeddedPair.sessionId).toBe('sess-1');
    });
  });

  // ==========================================================================
  // Skip Conditions
  // ==========================================================================

  describe('skip conditions', () => {
    beforeEach(() => {
      watcher.start();
    });

    it('should skip non-assistant messages', async () => {
      const userMessage = createMessage({
        role: 'user',
        content: 'A user message',
        state: 'complete',
      });

      mocks.triggerMessageComplete(userMessage);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mocks.mockEmbeddingService.embedConversationTurn).not.toHaveBeenCalled();
    });

    it('should skip tool messages', async () => {
      const toolMessage = createMessage({
        role: 'tool',
        content: '{"result": "success"}',
        state: 'complete',
        toolCallId: 'tc-123',
      });

      mocks.triggerMessageComplete(toolMessage);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mocks.mockEmbeddingService.embedConversationTurn).not.toHaveBeenCalled();
    });

    it('should skip non-complete assistant messages', async () => {
      const streamingMessage = createMessage({
        role: 'assistant',
        content: 'Still streaming...',
        state: 'streaming',
      });

      mocks.triggerMessageComplete(streamingMessage);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mocks.mockEmbeddingService.embedConversationTurn).not.toHaveBeenCalled();
    });

    it('should skip assistant messages with empty content', async () => {
      const emptyMessage = createMessage({
        role: 'assistant',
        content: '',
        state: 'complete',
      });

      mocks.triggerMessageComplete(emptyMessage);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mocks.mockEmbeddingService.embedConversationTurn).not.toHaveBeenCalled();
    });

    it('should skip assistant messages with null content', async () => {
      const nullMessage = createMessage({
        role: 'assistant',
        content: null,
        state: 'complete',
      });

      mocks.triggerMessageComplete(nullMessage);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mocks.mockEmbeddingService.embedConversationTurn).not.toHaveBeenCalled();
    });

    it('should skip assistant messages with whitespace-only content', async () => {
      const whitespaceMessage = createMessage({
        role: 'assistant',
        content: '   \n\t  ',
        state: 'complete',
      });

      mocks.triggerMessageComplete(whitespaceMessage);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mocks.mockEmbeddingService.embedConversationTurn).not.toHaveBeenCalled();
    });

    it('should skip branch conversations (parentConversationId set)', async () => {
      mocks.mockDb.queryOne.mockResolvedValueOnce({
        metadataJson: JSON.stringify({ parentConversationId: 'parent-conv-001' }),
      });

      const branchMessage = createMessage({
        conversationId: 'conv-branch-001',
        role: 'assistant',
        content: 'A response in a branch conversation.',
        state: 'complete',
      });

      mocks.triggerMessageComplete(branchMessage);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mocks.mockEmbeddingService.embedConversationTurn).not.toHaveBeenCalled();
    });

    it('should skip when no preceding user message is found', async () => {
      // isConversationBranch returns false
      mocks.mockDb.queryOne.mockResolvedValueOnce({ metadataJson: '{}' });
      // No user messages found
      mocks.mockMessageRepository.getMessagesBySequenceRange.mockResolvedValue([]);

      const assistantMessage = createMessage({
        conversationId: 'conv-no-user',
        role: 'assistant',
        content: 'A response with no preceding user message.',
        sequenceNumber: 0,
        state: 'complete',
      });

      mocks.triggerMessageComplete(assistantMessage);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mocks.mockEmbeddingService.embedConversationTurn).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  describe('error handling', () => {
    beforeEach(() => {
      watcher.start();
    });

    it('should not crash when embedding service throws', async () => {
      const userMessage = createMessage({
        role: 'user',
        content: 'A question',
        sequenceNumber: 0,
      });

      mocks.mockMessageRepository.getMessagesBySequenceRange.mockResolvedValue([userMessage]);
      mocks.mockDb.queryOne
        .mockResolvedValueOnce({ metadataJson: '{}' })
        .mockResolvedValueOnce({ workspaceId: null, sessionId: null });
      mocks.mockEmbeddingService.embedConversationTurn.mockRejectedValue(
        new Error('Embedding engine crashed')
      );

      const assistantMessage = createMessage({
        role: 'assistant',
        content: 'A response',
        sequenceNumber: 1,
        state: 'complete',
      });

      // Should not throw
      mocks.triggerMessageComplete(assistantMessage);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Error was logged (console.error is mocked in setup.ts)
      expect(console.error).toHaveBeenCalled();
    });

    it('should not crash when database query throws', async () => {
      mocks.mockDb.queryOne.mockRejectedValue(new Error('Database unavailable'));

      const assistantMessage = createMessage({
        role: 'assistant',
        content: 'A response',
        sequenceNumber: 1,
        state: 'complete',
      });

      // Should not throw
      mocks.triggerMessageComplete(assistantMessage);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(console.error).toHaveBeenCalled();
    });

    it('should handle invalid metadataJson gracefully', async () => {
      mocks.mockDb.queryOne.mockResolvedValueOnce({
        metadataJson: 'not-valid-json{{{{',
      });

      const assistantMessage = createMessage({
        conversationId: 'conv-bad-json',
        role: 'assistant',
        content: 'A response.',
        sequenceNumber: 1,
        state: 'complete',
      });

      // Invalid JSON in isConversationBranch returns false, so processing continues
      // Next call for conversation metadata
      mocks.mockDb.queryOne.mockResolvedValueOnce({ workspaceId: null, sessionId: null });
      mocks.mockMessageRepository.getMessagesBySequenceRange.mockResolvedValue([
        createMessage({ role: 'user', content: 'Question', sequenceNumber: 0 }),
      ]);

      mocks.triggerMessageComplete(assistantMessage);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should still attempt to embed (invalid JSON treated as "not a branch")
      expect(mocks.mockEmbeddingService.embedConversationTurn).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Conversation Metadata
  // ==========================================================================

  describe('conversation metadata passthrough', () => {
    beforeEach(() => {
      watcher.start();
    });

    it('should pass workspaceId and sessionId from conversation to QA pair', async () => {
      const userMessage = createMessage({
        role: 'user',
        content: 'A question',
        sequenceNumber: 0,
      });

      mocks.mockMessageRepository.getMessagesBySequenceRange.mockResolvedValue([userMessage]);
      mocks.mockDb.queryOne
        .mockResolvedValueOnce({ metadataJson: '{}' })
        .mockResolvedValueOnce({ workspaceId: 'ws-alpha', sessionId: 'sess-beta' });

      const assistantMessage = createMessage({
        role: 'assistant',
        content: 'An answer',
        sequenceNumber: 1,
        state: 'complete',
      });

      mocks.triggerMessageComplete(assistantMessage);
      await new Promise(resolve => setTimeout(resolve, 50));

      const pair = mocks.mockEmbeddingService.embedConversationTurn.mock.calls[0][0];
      expect(pair.workspaceId).toBe('ws-alpha');
      expect(pair.sessionId).toBe('sess-beta');
    });

    it('should handle null workspaceId and sessionId', async () => {
      const userMessage = createMessage({
        role: 'user',
        content: 'A question',
        sequenceNumber: 0,
      });

      mocks.mockMessageRepository.getMessagesBySequenceRange.mockResolvedValue([userMessage]);
      mocks.mockDb.queryOne
        .mockResolvedValueOnce({ metadataJson: '{}' })
        .mockResolvedValueOnce({ workspaceId: null, sessionId: null });

      const assistantMessage = createMessage({
        role: 'assistant',
        content: 'An answer',
        sequenceNumber: 1,
        state: 'complete',
      });

      mocks.triggerMessageComplete(assistantMessage);
      await new Promise(resolve => setTimeout(resolve, 50));

      const pair = mocks.mockEmbeddingService.embedConversationTurn.mock.calls[0][0];
      expect(pair.workspaceId).toBeUndefined();
      expect(pair.sessionId).toBeUndefined();
    });
  });
});
