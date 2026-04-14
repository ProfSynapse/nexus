/**
 * StreamingResponseService — applyCompactionBoundary unit tests
 *
 * Coverage:
 *   - When metadata.compaction.frontier has a latest record with boundaryMessageId,
 *     only messages at/after that ID are included in LLM context
 *   - When no boundary exists, all messages are included
 *   - When boundary ID not found in messages, all messages are included
 *   - When frontier is empty array, all messages are included
 *   - When boundary is at index 0, all messages are included (nothing to remove)
 *
 * Approach:
 *   applyCompactionBoundary is private, so we test it indirectly through
 *   buildLLMMessages (also private). We access it via (service as any) to
 *   verify the boundary filtering in isolation without needing full LLM deps.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ConversationData, ConversationMessage } from '../../src/types/chat/ChatTypes';

// Mock the imports that StreamingResponseService depends on
jest.mock('../../src/services/chat/ConversationContextBuilder', () => ({
  ConversationContextBuilder: {
    buildContextForProvider: jest.fn((conv: ConversationData) =>
      conv.messages.map((m: ConversationMessage) => ({ role: m.role, content: m.content }))
    ),
  },
}));

jest.mock('../../src/services/chat/ToolCallService', () => ({
  ToolCallService: jest.fn(),
}));

jest.mock('../../src/services/chat/CostTrackingService', () => ({
  CostTrackingService: jest.fn(),
}));

jest.mock('../../src/services/chat/ContextBudgetService', () => ({
  ContextBudgetService: {
    normalizeUsage: jest.fn(),
  },
}));

jest.mock('../../src/services/llm/utils/ToolSchemaSupport', () => ({
  shouldPassToolSchemasToProvider: jest.fn(() => false),
}));

import { StreamingResponseService } from '../../src/services/chat/StreamingResponseService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(id: string, role: 'user' | 'assistant', content: string): ConversationMessage {
  return {
    id,
    role,
    content,
    timestamp: Date.now(),
    conversationId: 'conv-1',
  } as ConversationMessage;
}

function makeConv(
  messages: ConversationMessage[],
  metadata?: Record<string, unknown>
): ConversationData {
  return {
    id: 'conv-1',
    title: 'Test',
    messages,
    created: Date.now(),
    updated: Date.now(),
    metadata,
  } as unknown as ConversationData;
}

function createService(): StreamingResponseService {
  const mockDeps = {
    llmService: {
      getDefaultModel: () => ({ provider: 'openai', model: 'gpt-4' }),
      generateResponseStream: jest.fn(),
    },
    conversationService: {
      getConversation: jest.fn(),
      addMessage: jest.fn(),
      updateConversation: jest.fn(),
    },
    toolCallService: {
      getAvailableTools: jest.fn(() => []),
      resetDetectedTools: jest.fn(),
      handleToolCallDetection: jest.fn(),
      fireToolEvent: jest.fn(),
    },
    costTrackingService: {
      extractUsage: jest.fn(),
      trackMessageUsage: jest.fn(),
      createUsageCallback: jest.fn(),
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

  it('filters out messages before the boundary when frontier has boundaryMessageId', () => {
    const messages = [
      makeMsg('m1', 'user', 'First question'),
      makeMsg('m2', 'assistant', 'First answer'),
      makeMsg('m3', 'user', 'Second question'),
      makeMsg('m4', 'assistant', 'Second answer'),
      makeMsg('m5', 'user', 'Third question'),
    ];

    const conv = makeConv(messages, {
      compaction: {
        frontier: [{ boundaryMessageId: 'm3' }],
      },
    });

    const result = (svc as any).applyCompactionBoundary(conv);

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].id).toBe('m3');
    expect(result.messages[1].id).toBe('m4');
    expect(result.messages[2].id).toBe('m5');
  });

  it('returns all messages when no metadata exists', () => {
    const messages = [
      makeMsg('m1', 'user', 'Q1'),
      makeMsg('m2', 'assistant', 'A1'),
    ];

    const conv = makeConv(messages);

    const result = (svc as any).applyCompactionBoundary(conv);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].id).toBe('m1');
  });

  it('returns all messages when compaction metadata has no frontier', () => {
    const messages = [
      makeMsg('m1', 'user', 'Q1'),
      makeMsg('m2', 'assistant', 'A1'),
    ];

    const conv = makeConv(messages, { compaction: {} });

    const result = (svc as any).applyCompactionBoundary(conv);

    expect(result.messages).toHaveLength(2);
  });

  it('returns all messages when frontier is empty array', () => {
    const messages = [
      makeMsg('m1', 'user', 'Q1'),
      makeMsg('m2', 'assistant', 'A1'),
    ];

    const conv = makeConv(messages, { compaction: { frontier: [] } });

    const result = (svc as any).applyCompactionBoundary(conv);

    expect(result.messages).toHaveLength(2);
  });

  it('returns all messages when frontier record has no boundaryMessageId', () => {
    const messages = [
      makeMsg('m1', 'user', 'Q1'),
      makeMsg('m2', 'assistant', 'A1'),
    ];

    const conv = makeConv(messages, {
      compaction: { frontier: [{ summary: 'Some summary' }] },
    });

    const result = (svc as any).applyCompactionBoundary(conv);

    expect(result.messages).toHaveLength(2);
  });

  it('returns all messages when boundaryMessageId is not found in messages', () => {
    const messages = [
      makeMsg('m1', 'user', 'Q1'),
      makeMsg('m2', 'assistant', 'A1'),
    ];

    const conv = makeConv(messages, {
      compaction: { frontier: [{ boundaryMessageId: 'nonexistent' }] },
    });

    const result = (svc as any).applyCompactionBoundary(conv);

    expect(result.messages).toHaveLength(2);
  });

  it('returns all messages when boundaryMessageId is at index 0 (nothing to remove)', () => {
    const messages = [
      makeMsg('m1', 'user', 'Q1'),
      makeMsg('m2', 'assistant', 'A1'),
    ];

    const conv = makeConv(messages, {
      compaction: { frontier: [{ boundaryMessageId: 'm1' }] },
    });

    const result = (svc as any).applyCompactionBoundary(conv);

    // Index 0 → boundaryIndex <= 0 → returns full conversation
    expect(result.messages).toHaveLength(2);
  });

  it('uses the LATEST frontier record when multiple exist', () => {
    const messages = [
      makeMsg('m1', 'user', 'Q1'),
      makeMsg('m2', 'assistant', 'A1'),
      makeMsg('m3', 'user', 'Q2'),
      makeMsg('m4', 'assistant', 'A2'),
      makeMsg('m5', 'user', 'Q3'),
    ];

    const conv = makeConv(messages, {
      compaction: {
        frontier: [
          { boundaryMessageId: 'm2' }, // older boundary
          { boundaryMessageId: 'm4' }, // latest boundary
        ],
      },
    });

    const result = (svc as any).applyCompactionBoundary(conv);

    // Should use m4 (latest), not m2
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].id).toBe('m4');
    expect(result.messages[1].id).toBe('m5');
  });

  it('does not mutate the original conversation object', () => {
    const messages = [
      makeMsg('m1', 'user', 'Q1'),
      makeMsg('m2', 'assistant', 'A1'),
      makeMsg('m3', 'user', 'Q2'),
    ];

    const conv = makeConv(messages, {
      compaction: { frontier: [{ boundaryMessageId: 'm2' }] },
    });

    const originalLength = conv.messages.length;
    (svc as any).applyCompactionBoundary(conv);

    expect(conv.messages.length).toBe(originalLength);
  });
});
