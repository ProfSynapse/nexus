/**
 * ConversationWindowRetriever Unit Tests
 *
 * Tests the windowed message retrieval around matched QA pairs.
 * Uses a mocked IMessageRepository for dependency isolation.
 */

import { ConversationWindowRetriever, MessageWindow } from '../../src/services/embeddings/ConversationWindowRetriever';
import type { IMessageRepository } from '../../src/database/repositories/interfaces/IMessageRepository';
import type { MessageData } from '../../src/types/storage/HybridStorageTypes';
import {
  createLongConversation,
  createMessage,
  resetMessageIdCounter,
  CONVERSATION_IDS,
} from '../fixtures/conversationSearch';

// ============================================================================
// Mock Repository
// ============================================================================

function createMockMessageRepository(messages: MessageData[] = []): jest.Mocked<IMessageRepository> {
  return {
    getMessages: jest.fn(),
    addMessage: jest.fn(),
    update: jest.fn(),
    deleteMessage: jest.fn(),
    getNextSequenceNumber: jest.fn(),
    countMessages: jest.fn(),
    getMessagesBySequenceRange: jest.fn(
      async (conversationId: string, startSeq: number, endSeq: number) => {
        return messages.filter(
          m =>
            m.conversationId === conversationId &&
            m.sequenceNumber >= startSeq &&
            m.sequenceNumber <= endSeq
        );
      }
    ),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ConversationWindowRetriever', () => {
  let retriever: ConversationWindowRetriever;
  let mockRepo: jest.Mocked<IMessageRepository>;
  let longConversation: MessageData[];

  beforeEach(() => {
    resetMessageIdCounter();
    // 10 turns = 20 messages, sequence numbers 0..19
    longConversation = createLongConversation(10, CONVERSATION_IDS.long);
    mockRepo = createMockMessageRepository(longConversation);
    retriever = new ConversationWindowRetriever(mockRepo);
  });

  // ==========================================================================
  // Default Window Size
  // ==========================================================================

  describe('default window size (3 turns)', () => {
    it('should return correct window around a match in the middle', async () => {
      // Match at sequence 10-11 (turn 5). Default windowSize=3, offset=6.
      // windowStart = max(0, 10-6) = 4, windowEnd = 11+6 = 17
      const result = await retriever.getWindow(CONVERSATION_IDS.long, 10, 11);

      expect(result.matchedSequenceRange).toEqual([10, 11]);
      expect(result.conversationId).toBe(CONVERSATION_IDS.long);

      // Should have called repository with correct range
      expect(mockRepo.getMessagesBySequenceRange).toHaveBeenCalledWith(
        CONVERSATION_IDS.long,
        4,
        17
      );

      // Should have messages in the range [4, 17]
      expect(result.messages.length).toBeGreaterThan(0);
      for (const msg of result.messages) {
        expect(msg.sequenceNumber).toBeGreaterThanOrEqual(4);
        expect(msg.sequenceNumber).toBeLessThanOrEqual(17);
      }
    });

    it('should report actual window boundaries from fetched messages', async () => {
      const result = await retriever.getWindow(CONVERSATION_IDS.long, 10, 11);

      // windowStart/End should reflect the actual fetched message boundaries
      expect(result.windowStart).toBe(4);
      expect(result.windowEnd).toBe(17);
    });
  });

  // ==========================================================================
  // Window at Start of Conversation
  // ==========================================================================

  describe('window at start of conversation', () => {
    it('should clamp windowStart to 0 when match is near the start', async () => {
      // Match at sequence 0-1 (very first turn). windowSize=3, offset=6.
      // windowStart = max(0, 0-6) = 0, windowEnd = 1+6 = 7
      const result = await retriever.getWindow(CONVERSATION_IDS.long, 0, 1);

      expect(mockRepo.getMessagesBySequenceRange).toHaveBeenCalledWith(
        CONVERSATION_IDS.long,
        0,
        7
      );

      expect(result.windowStart).toBe(0);
      expect(result.matchedSequenceRange).toEqual([0, 1]);
    });

    it('should clamp windowStart to 0 when match is at sequence 2-3', async () => {
      // windowStart = max(0, 2-6) = 0
      const result = await retriever.getWindow(CONVERSATION_IDS.long, 2, 3);

      expect(mockRepo.getMessagesBySequenceRange).toHaveBeenCalledWith(
        CONVERSATION_IDS.long,
        0,
        9
      );

      expect(result.windowStart).toBe(0);
    });
  });

  // ==========================================================================
  // Window at End of Conversation
  // ==========================================================================

  describe('window at end of conversation', () => {
    it('should return whatever messages exist past the match at end', async () => {
      // Last turn: sequence 18-19. windowEnd = 19+6 = 25 (beyond conversation).
      const result = await retriever.getWindow(CONVERSATION_IDS.long, 18, 19);

      expect(mockRepo.getMessagesBySequenceRange).toHaveBeenCalledWith(
        CONVERSATION_IDS.long,
        12,
        25
      );

      // Should still get messages up to 19 (the max available)
      expect(result.windowEnd).toBe(19);
      expect(result.messages.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Custom Window Size
  // ==========================================================================

  describe('custom window size', () => {
    it('should respect windowSize=1 for narrow window', async () => {
      // windowSize=1, offset = 1*2 = 2
      // Match at 10-11: windowStart = max(0,10-2) = 8, windowEnd = 11+2 = 13
      const result = await retriever.getWindow(CONVERSATION_IDS.long, 10, 11, { windowSize: 1 });

      expect(mockRepo.getMessagesBySequenceRange).toHaveBeenCalledWith(
        CONVERSATION_IDS.long,
        8,
        13
      );
    });

    it('should respect windowSize=5 for wide window', async () => {
      // windowSize=5, offset = 5*2 = 10
      // Match at 10-11: windowStart = max(0,10-10) = 0, windowEnd = 11+10 = 21
      const result = await retriever.getWindow(CONVERSATION_IDS.long, 10, 11, { windowSize: 5 });

      expect(mockRepo.getMessagesBySequenceRange).toHaveBeenCalledWith(
        CONVERSATION_IDS.long,
        0,
        21
      );
    });
  });

  // ==========================================================================
  // Empty Conversation
  // ==========================================================================

  describe('empty conversation', () => {
    it('should return empty messages array for conversation with no messages', async () => {
      const emptyRepo = createMockMessageRepository([]);
      const emptyRetriever = new ConversationWindowRetriever(emptyRepo);

      const result = await emptyRetriever.getWindow(CONVERSATION_IDS.empty, 0, 1);

      expect(result.messages).toEqual([]);
      expect(result.conversationId).toBe(CONVERSATION_IDS.empty);
      expect(result.matchedSequenceRange).toEqual([0, 1]);
    });

    it('should use computed boundaries when no messages are returned', async () => {
      const emptyRepo = createMockMessageRepository([]);
      const emptyRetriever = new ConversationWindowRetriever(emptyRepo);

      const result = await emptyRetriever.getWindow(CONVERSATION_IDS.empty, 10, 11);

      // When no messages, windowStart/End fall back to computed values
      expect(result.windowStart).toBe(4); // max(0, 10-6)
      expect(result.windowEnd).toBe(17);  // 11+6
    });
  });

  // ==========================================================================
  // Input Validation
  // ==========================================================================

  describe('input validation', () => {
    it('should throw error for empty conversationId', async () => {
      await expect(
        retriever.getWindow('', 0, 1)
      ).rejects.toThrow('conversationId is required');
    });

    it('should throw error for negative startSeq', async () => {
      await expect(
        retriever.getWindow(CONVERSATION_IDS.long, -1, 1)
      ).rejects.toThrow('Sequence numbers must be non-negative');
    });

    it('should throw error for negative endSeq', async () => {
      await expect(
        retriever.getWindow(CONVERSATION_IDS.long, 0, -1)
      ).rejects.toThrow('Sequence numbers must be non-negative');
    });

    it('should throw error when startSeq > endSeq', async () => {
      await expect(
        retriever.getWindow(CONVERSATION_IDS.long, 5, 3)
      ).rejects.toThrow('matchedStartSeq (5) must be <= matchedEndSeq (3)');
    });

    it('should accept startSeq equal to endSeq', async () => {
      // Same sequence for start and end (single message match)
      const result = await retriever.getWindow(CONVERSATION_IDS.long, 5, 5);
      expect(result.matchedSequenceRange).toEqual([5, 5]);
    });
  });

  // ==========================================================================
  // Message Ordering
  // ==========================================================================

  describe('message ordering', () => {
    it('should return messages ordered by sequence number ascending', async () => {
      const result = await retriever.getWindow(CONVERSATION_IDS.long, 10, 11);

      for (let i = 1; i < result.messages.length; i++) {
        expect(result.messages[i].sequenceNumber).toBeGreaterThan(
          result.messages[i - 1].sequenceNumber
        );
      }
    });
  });

  // ==========================================================================
  // Short Conversation (fewer messages than window)
  // ==========================================================================

  describe('short conversation', () => {
    it('should return all available messages when conversation is shorter than window', async () => {
      // 2 turns = 4 messages (seq 0..3). Match at 0-1, window requests -6 to 7.
      const shortConversation = createLongConversation(2, 'conv-short');
      const shortRepo = createMockMessageRepository(shortConversation);
      const shortRetriever = new ConversationWindowRetriever(shortRepo);

      const result = await shortRetriever.getWindow('conv-short', 0, 1);

      // Should return all 4 messages
      expect(result.messages).toHaveLength(4);
      expect(result.windowStart).toBe(0);
      expect(result.windowEnd).toBe(3);
    });
  });
});
