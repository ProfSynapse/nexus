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
import { CostTrackingService } from '../../src/services/chat/CostTrackingService';

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

describe('StreamingResponseService terminal persistence', () => {
  it('persists an in-band failed turn as invalid before yielding it', async () => {
    const assistant = makeMsg({ id: 'assistant-1', role: 'assistant', content: '', state: 'draft' });
    const conversation = makeConversation([
      makeMsg({ id: 'user-1', role: 'user', content: 'hello' }),
      assistant,
    ]);
    const updateConversation = jest.fn().mockResolvedValue(undefined);
    const service = new StreamingResponseService({
      llmService: {
        getDefaultModel: () => ({ provider: 'test', model: 'test-model' }),
        generateResponseStream: async function* () {
          yield { type: 'assistant.delta' as const, text: 'partial' };
          yield { type: 'turn.failed' as const, error: { message: 'provider failed', provider: 'test' } };
        },
      },
      conversationService: {
        getConversation: jest.fn(async () => conversation),
        addMessage: jest.fn().mockResolvedValue(undefined),
        updateConversation,
      },
      toolCallService: {
        getAvailableTools: jest.fn().mockReturnValue([]),
        resetDetectedTools: jest.fn(),
        handleToolCallDetection: jest.fn(),
        fireToolEvent: jest.fn(),
      } as any,
      costTrackingService: {
        createUsageCallback: jest.fn(),
        extractUsage: jest.fn(),
        trackMessageUsage: jest.fn(),
      } as any,
    });

    const events = [];
    for await (const envelope of service.generateResponse('conv-test', 'hello', { messageId: 'assistant-1' })) {
      events.push(envelope.event.type);
    }

    expect(events).toEqual(['assistant.delta', 'turn.failed']);
    expect(assistant).toEqual(expect.objectContaining({
      content: 'partial',
      state: 'invalid',
      isLoading: false,
      metadata: expect.objectContaining({
        runtimeError: expect.objectContaining({ message: 'provider failed' }),
      }),
    }));
    expect(updateConversation).toHaveBeenCalledTimes(1);
  });
});

describe('StreamingResponseService retry after handoff', () => {
  function retryService(conversation: ConversationData) {
    const generateResponseStream = jest.fn(async function* () {
      yield { type: 'turn.completed' as const };
    });
    const service = new StreamingResponseService({
      llmService: {
        getDefaultModel: () => ({ provider: 'openai', model: 'small' }),
        generateResponseStream,
      },
      conversationService: {
        getConversation: jest.fn(async () => conversation),
        addMessage: jest.fn().mockResolvedValue(undefined),
        updateConversation: jest.fn().mockResolvedValue(undefined),
      },
      toolCallService: {
        getAvailableTools: jest.fn().mockReturnValue([]),
        resetDetectedTools: jest.fn(),
        handleToolCallDetection: jest.fn(),
        fireToolEvent: jest.fn(),
      } as any,
      costTrackingService: {
        createUsageCallback: jest.fn(),
        extractUsage: jest.fn(),
        trackMessageUsage: jest.fn(),
      } as any,
    });
    return { service, generateResponseStream };
  }

  it('rejects retry of a turn summarized by an after boundary before the LLM sees old context', async () => {
    const conversation = makeConversation([
      makeMsg({ id: 'u1', role: 'user', content: 'old user content' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'old assistant content' }),
    ], { compaction: { frontier: [{ summary: 'Compact summary', boundaryMessageId: 'a1', boundaryMode: 'after' }] } });
    const { service, generateResponseStream } = retryService(conversation);
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const run = async () => {
        for await (const _chunk of service.generateResponse('conv-test', 'old user content', {
          messageId: 'a1', excludeFromMessageId: 'a1', systemPrompt: 'Compact summary'
        })) { /* consume */ }
      };
      await expect(run()).rejects.toThrow('summarized during context compaction');
      expect(generateResponseStream).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('keeps an at-boundary user turn when retrying its following assistant', async () => {
    const conversation = makeConversation([
      makeMsg({ id: 'u1', role: 'user', content: 'old user content' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'old assistant content' }),
      makeMsg({ id: 'u2', role: 'user', content: 'retained user content' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'retry this answer' }),
    ], { compaction: { frontier: [{ summary: 'Compact summary', boundaryMessageId: 'u2', boundaryMode: 'at' }] } });
    const { service, generateResponseStream } = retryService(conversation);
    for await (const _chunk of service.generateResponse('conv-test', 'retained user content', {
      messageId: 'a2', excludeFromMessageId: 'a2', systemPrompt: 'Compact summary'
    })) { /* consume */ }
    expect(generateResponseStream).toHaveBeenCalledTimes(1);
    const modelMessages = generateResponseStream.mock.calls[0][0];
    expect(JSON.stringify(modelMessages)).toContain('retained user content');
    expect(JSON.stringify(modelMessages)).not.toContain('old user content');
    expect(JSON.stringify(modelMessages)).not.toContain('old assistant content');
  });

  it('sends a post-handoff follow-up with its summary and without summarized turns', async () => {
    const conversation = makeConversation([
      makeMsg({ id: 'u1', role: 'user', content: 'old user content' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'old assistant content' }),
      makeMsg({ id: 'u2', role: 'user', content: 'new follow-up' }),
      makeMsg({ id: 'a2', role: 'assistant', content: '', state: 'draft' }),
    ], { compaction: { frontier: [{ summary: 'Compact summary', boundaryMessageId: 'a1', boundaryMode: 'after' }] } });
    const { service, generateResponseStream } = retryService(conversation);
    for await (const _chunk of service.generateResponse('conv-test', 'new follow-up', {
      messageId: 'a2', systemPrompt: 'Compact summary'
    })) { /* consume */ }
    const modelMessages = generateResponseStream.mock.calls[0][0];
    const sent = JSON.stringify(modelMessages);
    expect(sent).toContain('Compact summary');
    expect(sent).toContain('new follow-up');
    expect(sent).not.toContain('old user content');
    expect(sent).not.toContain('old assistant content');
  });
});

describe('StreamingResponseService cost updates', () => {
  it('defers a provider fallback until terminal persistence and adds it to inline response cost once', async () => {
    let stored = makeConversation([
      makeMsg({ id: 'user-1', role: 'user', content: 'hello' }),
      makeMsg({ id: 'assistant-1', role: 'assistant', content: '', state: 'draft' }),
    ]);
    stored.cost = { totalCost: 0, currency: 'USD' };
    const getConversation = jest.fn(async () => structuredClone(stored));
    const updateConversation = jest.fn(async (_id: string, updates: Partial<ConversationData>) => {
      stored = { ...stored, ...structuredClone(updates) };
    });
    const callbackPromises: Promise<void>[] = [];
    let callbackSettled = false;
    const costTrackingService = new CostTrackingService({ getConversation, updateConversation });
    const service = new StreamingResponseService({
      llmService: {
        getDefaultModel: () => ({ provider: 'openrouter', model: 'unlisted/model' }),
        generateResponseStream: async function* (_messages, options) {
          const fallback = options.onUsageAvailable as (usage: { promptTokens: number; completionTokens: number; totalTokens: number }, cost: { totalCost: number; currency: string }) => Promise<void>;
          yield { type: 'usage.updated' as const, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, providerCost: { totalCost: 0.02, currency: 'USD' } } };
          yield { type: 'response.completed' as const };
          callbackPromises.push(fallback({ promptTokens: 200, completionTokens: 20, totalTokens: 220 }, { totalCost: 0.03, currency: 'USD' }).then(() => { callbackSettled = true; }));
          yield { type: 'assistant.delta' as const, text: 'done' };
          yield { type: 'turn.completed' as const };
        },
      },
      conversationService: { getConversation, addMessage: jest.fn(), updateConversation },
      toolCallService: {
        getAvailableTools: jest.fn().mockReturnValue([]),
        resetDetectedTools: jest.fn(),
        handleToolCallDetection: jest.fn(),
        fireToolEvent: jest.fn(),
      } as any,
      costTrackingService,
    });

    for await (const envelope of service.generateResponse('conv-test', 'hello', { messageId: 'assistant-1' })) {
      if (envelope.event.type === 'turn.completed') {
        expect(callbackSettled).toBe(false);
        expect(stored.messages[1]).toEqual(expect.objectContaining({ content: 'done', state: 'complete' }));
        expect(stored.messages[1].cost?.totalCost).toBeCloseTo(0.02);
      }
    }
    await Promise.all(callbackPromises);

    expect(stored.messages[1].usage).toEqual(expect.objectContaining({ promptTokens: 300, completionTokens: 30 }));
    expect(stored.messages[1].cost?.totalCost).toBeCloseTo(0.05);
    expect(stored.cost?.totalCost).toBeCloseTo(0.05);
    expect(stored.messages[1].metadata?.latestResponseUsage).toEqual(expect.objectContaining({ promptTokens: 100 }));
  });

  it('charges cumulative usage snapshots once and exposes cost before a tool finishes', async () => {
    const assistant = makeMsg({ id: 'assistant-1', role: 'assistant', content: '' });
    const conversation = makeConversation([
      makeMsg({ id: 'user-1', role: 'user', content: 'hello' }), assistant,
    ]);
    const track = jest.fn().mockResolvedValue(undefined);
    const service = new StreamingResponseService({
      llmService: {
        getDefaultModel: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
        generateResponseStream: async function* () {
          yield { type: 'usage.updated' as const, usage: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 100 } };
          yield { type: 'usage.updated' as const, usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cacheReadTokens: 800, cacheWriteTokens: 100 } };
          yield { type: 'response.completed' as const };
          yield { type: 'tool.execution.started' as const, operationId: 'tool', call: { id: 'tool', type: 'function' as const, function: { name: 'test', arguments: '{}' } } };
          yield { type: 'usage.updated' as const, usage: { promptTokens: 2000, completionTokens: 50, totalTokens: 2050 } };
          yield { type: 'response.completed' as const };
          yield { type: 'turn.completed' as const };
        },
      },
      conversationService: {
        getConversation: jest.fn(async () => conversation),
        addMessage: jest.fn().mockResolvedValue(undefined),
        updateConversation: jest.fn().mockResolvedValue(undefined),
      },
      toolCallService: {
        getAvailableTools: jest.fn().mockReturnValue([]),
        resetDetectedTools: jest.fn(),
        handleToolCallDetection: jest.fn(),
        fireToolEvent: jest.fn(),
      } as any,
      costTrackingService: {
        createUsageCallback: jest.fn(),
        extractUsage: (usage: unknown) => usage,
        calculateCost: (_provider: string, _model: string, usage: { promptTokens: number; completionTokens: number }) => ({ totalCost: usage.promptTokens / 1000 + usage.completionTokens / 10000, currency: 'USD' }),
        updateMessageCost: track,
      } as any,
    });

    const events = [];
    for await (const envelope of service.generateResponse('conv-test', 'hello', { messageId: 'assistant-1' })) {
      events.push(envelope.event);
    }
    const costEvents = events.filter((event) => event.type === 'cost.updated');
    expect(costEvents.length).toBeGreaterThanOrEqual(3);
    expect(costEvents.at(-1)?.type).toBe('cost.updated');
    expect((costEvents.at(-1) as { cost: { totalCost: number } }).cost.totalCost).toBeCloseTo(3.015);
    expect(events.findIndex((event) => event.type === 'cost.updated')).toBeLessThan(events.findIndex((event) => event.type === 'tool.execution.started'));
    expect(track).toHaveBeenLastCalledWith('conv-test', 'assistant-1', expect.objectContaining({ promptTokens: 3000, completionTokens: 150, cacheReadTokens: 800 }), expect.objectContaining({ currency: 'USD' }));
    expect(assistant.metadata?.latestResponseUsage).toEqual(expect.objectContaining({ promptTokens: 2000, completionTokens: 50 }));
  });
});
