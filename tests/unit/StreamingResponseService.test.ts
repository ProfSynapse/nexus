/**
 * StreamingResponseService Unit Tests
 *
 * Coverage:
 *   - applyCompactionBoundary: filters messages based on metadata.compaction.frontier
 *     - When frontier has boundaryMessageId, only messages at/after that ID are included
 *     - When no frontier exists, all messages are returned
 *     - When frontier exists but no boundaryMessageId, all messages returned
 *     - When boundaryMessageId not found in messages, all messages returned
 *     - When boundaryMessageId is the first message, all messages returned (index 0 check)
 *     - Multiple frontier records: uses the latest (last) record
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ConversationData, ConversationMessage } from '../../src/types/chat/ChatTypes';
import { StreamingResponseService } from '../../src/services/chat/StreamingResponseService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(
  overrides: Partial<ConversationMessage> & { id: string; role: ConversationMessage['role'] }
): ConversationMessage {
  return {
    content: '',
    timestamp: Date.now(),
    conversationId: 'conv-test',
    ...overrides,
  } as ConversationMessage;
}

function makeConversation(
  messages: ConversationMessage[],
  metadata?: Record<string, unknown>
): ConversationData {
  return {
    id: 'conv-test',
    title: 'Test',
    messages,
    created: Date.now(),
    updated: Date.now(),
    metadata: metadata as any,
  };
}

/**
 * Access the private applyCompactionBoundary method via type cast.
 */
function callApplyBoundary(svc: StreamingResponseService, conv: ConversationData): ConversationData {
  return (svc as any).applyCompactionBoundary(conv);
}

function createService(): StreamingResponseService {
  const mockDeps = {
    llmService: {
      getDefaultModel: jest.fn().mockReturnValue({ provider: 'test', model: 'test-model' }),
      generateResponseStream: jest.fn(),
    },
    conversationService: {
      getConversation: jest.fn(),
      addMessage: jest.fn(),
      updateConversation: jest.fn(),
    },
    toolCallService: {
      getAvailableTools: jest.fn().mockReturnValue([]),
      resetDetectedTools: jest.fn(),
      handleToolCallDetection: jest.fn(),
      fireToolEvent: jest.fn(),
    },
    costTrackingService: {
      createUsageCallback: jest.fn(),
      extractUsage: jest.fn(),
      trackMessageUsage: jest.fn(),
    },
  };
  return new StreamingResponseService(mockDeps as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamingResponseService — applyCompactionBoundary', () => {
  let svc: StreamingResponseService;

  beforeEach(() => {
    svc = createService();
  });

  it('filters messages to only those at/after boundaryMessageId', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Old Q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Old A1' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Kept Q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'Kept A2' }),
      makeMsg({ id: 'u3', role: 'user', content: 'Kept Q3' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'Kept A3' }),
    ];
    const conv = makeConversation(messages, {
      compaction: {
        frontier: [{ boundaryMessageId: 'u2' }],
      },
    });

    const result = callApplyBoundary(svc, conv);

    expect(result.messages.length).toBe(4);
    expect(result.messages[0].id).toBe('u2');
    expect(result.messages[3].id).toBe('a3');
  });

  it('returns all messages when no frontier exists', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'A1' }),
    ];
    const conv = makeConversation(messages);

    const result = callApplyBoundary(svc, conv);

    expect(result.messages.length).toBe(2);
    expect(result.messages).toEqual(messages);
  });

  it('returns all messages when frontier is empty array', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'A1' }),
    ];
    const conv = makeConversation(messages, {
      compaction: { frontier: [] },
    });

    const result = callApplyBoundary(svc, conv);

    expect(result.messages.length).toBe(2);
  });

  it('returns all messages when frontier record has no boundaryMessageId', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'A1' }),
    ];
    const conv = makeConversation(messages, {
      compaction: {
        frontier: [{ summary: 'Some summary' }],
      },
    });

    const result = callApplyBoundary(svc, conv);

    expect(result.messages.length).toBe(2);
  });

  it('returns all messages when boundaryMessageId is not found in messages', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'A1' }),
    ];
    const conv = makeConversation(messages, {
      compaction: {
        frontier: [{ boundaryMessageId: 'nonexistent' }],
      },
    });

    const result = callApplyBoundary(svc, conv);

    expect(result.messages.length).toBe(2);
  });

  it('returns all messages when boundaryMessageId is the first message (index 0)', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'A1' }),
    ];
    const conv = makeConversation(messages, {
      compaction: {
        frontier: [{ boundaryMessageId: 'u1' }],
      },
    });

    const result = callApplyBoundary(svc, conv);

    // boundaryIndex=0, and the code checks `if (boundaryIndex <= 0)` → returns full conversation
    expect(result.messages.length).toBe(2);
  });

  it('uses the latest frontier record when multiple exist', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Very old' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Very old A' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Old' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'Old A' }),
      makeMsg({ id: 'u3', role: 'user', content: 'Current' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'Current A' }),
    ];
    const conv = makeConversation(messages, {
      compaction: {
        frontier: [
          { boundaryMessageId: 'u2' }, // Older compaction
          { boundaryMessageId: 'u3' }, // Latest compaction — should use this
        ],
      },
    });

    const result = callApplyBoundary(svc, conv);

    expect(result.messages.length).toBe(2);
    expect(result.messages[0].id).toBe('u3');
    expect(result.messages[1].id).toBe('a3');
  });

  it('does not mutate the original conversation object', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Old' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Old A' }),
      makeMsg({ id: 'u2', role: 'user', content: 'New' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'New A' }),
    ];
    const conv = makeConversation(messages, {
      compaction: {
        frontier: [{ boundaryMessageId: 'u2' }],
      },
    });

    const originalLength = conv.messages.length;
    callApplyBoundary(svc, conv);

    expect(conv.messages.length).toBe(originalLength);
  });

  it('returns a new conversation object with filtered messages (spread copy)', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Old' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Old A' }),
      makeMsg({ id: 'u2', role: 'user', content: 'New' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'New A' }),
    ];
    const conv = makeConversation(messages, {
      compaction: {
        frontier: [{ boundaryMessageId: 'u2' }],
      },
    });

    const result = callApplyBoundary(svc, conv);

    // Should be a different object
    expect(result).not.toBe(conv);
    // But preserve other fields
    expect(result.id).toBe(conv.id);
    expect(result.title).toBe(conv.title);
  });

  it('returns same reference when no filtering needed (no frontier)', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Q1' }),
    ];
    const conv = makeConversation(messages);

    const result = callApplyBoundary(svc, conv);

    // When no filtering needed, returns the original object
    expect(result).toBe(conv);
  });
});
