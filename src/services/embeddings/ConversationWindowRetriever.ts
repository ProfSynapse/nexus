/**
 * Location: src/services/embeddings/ConversationWindowRetriever.ts
 *
 * Conversation Window Retriever
 *
 * Retrieves a window of messages surrounding a matched QA pair in a
 * conversation. Used by the scoped search mode of Conversation Memory Search
 * to provide N turns of context before and after a semantic search hit.
 *
 * A "turn" is approximately 2 messages (one user message + one assistant
 * response), so the actual sequence number range is windowSize * 2 in each
 * direction from the matched pair.
 *
 * Related Files:
 * - src/database/repositories/interfaces/IMessageRepository.ts - Message query interface
 * - src/database/repositories/MessageRepository.ts - Message query implementation
 * - src/services/embeddings/EmbeddingService.ts - Semantic search that produces match locations
 * - src/agents/searchManager/services/MemorySearchProcessor.ts - Orchestrates search + window retrieval
 */

import { MessageData } from '../../types/storage/HybridStorageTypes';
import { IMessageRepository } from '../../database/repositories/interfaces/IMessageRepository';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for controlling the window size around a matched QA pair.
 *
 * @property windowSize - Number of turns (user+assistant pairs) to include
 *   before AND after the matched sequence range. Default: 3.
 */
export interface WindowOptions {
  windowSize: number;
}

/**
 * Result of a windowed message retrieval.
 *
 * Contains the messages within the computed window, plus metadata about the
 * window boundaries and the original match location.
 */
export interface MessageWindow {
  /** Messages in the window, ordered by sequence number ascending */
  messages: MessageData[];

  /** The original matched QA pair's sequence number range [start, end] */
  matchedSequenceRange: [number, number];

  /** First sequence number in the retrieved window */
  windowStart: number;

  /** Last sequence number in the retrieved window */
  windowEnd: number;

  /** The conversation this window belongs to */
  conversationId: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Default number of turns to include before and after the matched pair */
const DEFAULT_WINDOW_SIZE = 3;

/**
 * Messages per turn. A turn is approximately one user message + one assistant
 * response. This multiplier converts turn count to sequence number offset.
 */
const MESSAGES_PER_TURN = 2;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Retrieves a window of messages surrounding a matched QA pair.
 *
 * Given a matched pair at sequence numbers [startSeq, endSeq], this class
 * computes a broader window and fetches all messages within that range.
 * The window extends windowSize * 2 sequence numbers in each direction
 * (since each "turn" is roughly 2 messages).
 *
 * Edge cases handled:
 * - Match at start of conversation: windowStart clamps to 0
 * - Match at end of conversation: returns whatever messages exist past endSeq
 * - Short conversations: returns all available messages without error
 * - Empty conversations: returns empty messages array
 *
 * @example
 * ```typescript
 * const retriever = new ConversationWindowRetriever(messageRepository);
 *
 * // Fetch 3 turns before and after a match at sequence numbers 10-11
 * const window = await retriever.getWindow('conv-123', 10, 11);
 * // windowStart = max(0, 10 - 6) = 4
 * // windowEnd = 11 + 6 = 17
 * // Returns messages with sequenceNumber 4..17
 * ```
 */
export class ConversationWindowRetriever {
  private readonly messageRepository: IMessageRepository;

  /**
   * @param messageRepository - Repository for querying messages by sequence range.
   *   Accepts IMessageRepository for testability via dependency injection.
   */
  constructor(messageRepository: IMessageRepository) {
    this.messageRepository = messageRepository;
  }

  /**
   * Retrieve a window of messages around a matched QA pair.
   *
   * @param conversationId - The conversation containing the matched pair
   * @param matchedStartSeq - Start sequence number of the matched QA pair
   * @param matchedEndSeq - End sequence number of the matched QA pair
   * @param options - Optional window configuration (windowSize defaults to 3)
   * @returns A MessageWindow with the retrieved messages and boundary metadata
   *
   * @throws Error if conversationId is empty
   * @throws Error if matchedStartSeq > matchedEndSeq
   * @throws Error if sequence numbers are negative
   */
  async getWindow(
    conversationId: string,
    matchedStartSeq: number,
    matchedEndSeq: number,
    options?: Partial<WindowOptions>
  ): Promise<MessageWindow> {
    // Validate inputs
    if (!conversationId) {
      throw new Error('conversationId is required');
    }
    if (matchedStartSeq < 0 || matchedEndSeq < 0) {
      throw new Error('Sequence numbers must be non-negative');
    }
    if (matchedStartSeq > matchedEndSeq) {
      throw new Error(
        `matchedStartSeq (${matchedStartSeq}) must be <= matchedEndSeq (${matchedEndSeq})`
      );
    }

    const windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
    const sequenceOffset = windowSize * MESSAGES_PER_TURN;

    // Compute window boundaries
    const windowStart = Math.max(0, matchedStartSeq - sequenceOffset);
    const windowEnd = matchedEndSeq + sequenceOffset;

    // Fetch messages within the computed range
    const messages = await this.messageRepository.getMessagesBySequenceRange(
      conversationId,
      windowStart,
      windowEnd
    );

    // Determine actual boundaries from fetched messages.
    // If the conversation has fewer messages than the window requests,
    // we report the actual boundaries rather than the computed ones.
    const actualWindowStart = messages.length > 0
      ? messages[0].sequenceNumber
      : windowStart;
    const actualWindowEnd = messages.length > 0
      ? messages[messages.length - 1].sequenceNumber
      : windowEnd;

    return {
      messages,
      matchedSequenceRange: [matchedStartSeq, matchedEndSeq],
      windowStart: actualWindowStart,
      windowEnd: actualWindowEnd,
      conversationId
    };
  }
}
