/**
 * Canonical Message Pipeline — Phase 3 regression tests
 *
 * Pins the field-preserving passthrough across the pre-network pipeline:
 *
 *   StreamingResponseService.buildLLMMessages
 *     → LLMService.generateResponseStream (Phase 3: no remap)
 *       → StreamingOrchestrator boundary
 *
 * Historically each hop had its own `.map()` that silently dropped fields —
 * `tool_call_id` loss caused the Azure "Missing required parameter:
 * 'input[N].call_id'" bug, and `reasoning_details` / `thought_signature` /
 * `name` were latent risks. Phase 3 deleted the LLMService remap so messages
 * flow through untouched; these tests fail loudly if a remap is reintroduced.
 *
 * See docs/plans/canonical-message-pipeline-plan.md (Option B / Phase 3).
 */

import type { ConversationData } from '../../src/types';
import type { ConversationMessage as LLMConversationMessage } from '../../src/services/llm/core/ProviderMessageBuilder';
import type { LLMProviderSettings } from '../../src/types';
import { ConversationContextBuilder } from '../../src/services/chat/ConversationContextBuilder';
import { StreamingResponseService, StreamingDependencies } from '../../src/services/chat/StreamingResponseService';

// ---------------------------------------------------------------------------
// LLMService collaborator mocks (only affect the LLMService passthrough tests)
// ---------------------------------------------------------------------------

const mockOrchestratorCalls: Array<{ messages: LLMConversationMessage[]; options: unknown }> = [];

jest.mock('../../src/services/llm/core/StreamingOrchestrator', () => ({
  StreamingOrchestrator: jest.fn().mockImplementation(() => ({
    async *generateResponseStream(messages: LLMConversationMessage[], options: unknown) {
      mockOrchestratorCalls.push({ messages, options });
      yield { chunk: 'done', complete: true, content: 'done' };
    },
  })),
}));

jest.mock('../../src/services/llm/core/AdapterRegistry', () => ({
  AdapterRegistry: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    updateSettings: jest.fn(),
    setOnSettingsDirty: jest.fn(),
    getAdapter: jest.fn(),
    getAvailableProviders: jest.fn(() => []),
    isProviderAvailable: jest.fn(() => false),
    waitForInit: jest.fn(),
    clear: jest.fn(),
  })),
}));

jest.mock('../../src/services/llm/core/ModelDiscoveryService', () => ({
  ModelDiscoveryService: jest.fn().mockImplementation(() => ({
    getAvailableModels: jest.fn(async () => []),
  })),
}));

import { LLMService } from '../../src/services/llm/core/LLMService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Stored conversation with a prior tool-call round (mirrors the Azure repro). */
function makeToolCallConversation(): ConversationData {
  return {
    id: 'conv-pipeline',
    title: 'Pipeline test',
    created: Date.now(),
    updated: Date.now(),
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'What is the weather in Paris?',
        timestamp: Date.now(),
        conversationId: 'conv-pipeline',
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        conversationId: 'conv-pipeline',
        toolCalls: [
          {
            id: 'call_abc123',
            type: 'function' as const,
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            success: true,
            result: { temp: 20, condition: 'cloudy' },
          },
        ],
      },
      {
        id: 'm3',
        role: 'assistant',
        content: 'Paris is 20C and cloudy.',
        timestamp: Date.now(),
        conversationId: 'conv-pipeline',
      },
      {
        id: 'm4',
        role: 'user',
        content: 'Now check Tokyo.',
        timestamp: Date.now(),
        conversationId: 'conv-pipeline',
      },
    ],
  } as unknown as ConversationData;
}

/** Context-builder output carrying every preserved field. */
function makeRichContextMessages(): LLMConversationMessage[] {
  return [
    { role: 'system', content: 'sys prompt' },
    { role: 'user', content: 'What is the weather in Paris?' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_abc123',
          type: 'function' as const,
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        },
      ],
      reasoning_details: [{ type: 'reasoning.text', text: 'Considering Paris weather...' }],
      thought_signature: 'sig-gemini-001',
    },
    {
      role: 'tool',
      content: '{"temp":20,"condition":"cloudy"}',
      tool_call_id: 'call_abc123',
      name: 'get_weather',
    },
    { role: 'user', content: 'Now check Tokyo.' },
  ];
}

function makeStreamingDeps(overrides?: {
  generateResponseStream?: StreamingDependencies['llmService']['generateResponseStream'];
  getConversation?: jest.Mock;
}): StreamingDependencies {
  return {
    llmService: {
      getDefaultModel: jest.fn(() => ({ provider: 'openrouter', model: 'test-model' })),
      generateResponseStream:
        overrides?.generateResponseStream ??
        // eslint-disable-next-line require-yield
        (async function* () {
          throw new Error('generateResponseStream not stubbed');
        }),
    },
    conversationService: {
      getConversation: overrides?.getConversation ?? jest.fn(async () => null),
      addMessage: jest.fn(async () => undefined),
      updateConversation: jest.fn(async () => undefined),
    },
    toolCallService: {
      getAvailableTools: jest.fn(() => []),
      resetDetectedTools: jest.fn(),
      handleToolCallDetection: jest.fn(),
      fireToolEvent: jest.fn(),
    } as unknown as StreamingDependencies['toolCallService'],
    costTrackingService: {
      createUsageCallback: jest.fn(),
      extractUsage: jest.fn(),
      trackMessageUsage: jest.fn(),
    } as unknown as StreamingDependencies['costTrackingService'],
  };
}

type BuildLLMMessagesFn = (
  conversation: ConversationData,
  provider?: string,
  systemPrompt?: string
) => LLMConversationMessage[];

function callBuildLLMMessages(
  svc: StreamingResponseService,
  conversation: ConversationData,
  provider: string,
  systemPrompt?: string
): LLMConversationMessage[] {
  return (svc as unknown as { buildLLMMessages: BuildLLMMessagesFn }).buildLLMMessages(
    conversation,
    provider,
    systemPrompt
  );
}

// ---------------------------------------------------------------------------
// 1. buildLLMMessages — field preservation (real ConversationContextBuilder)
// ---------------------------------------------------------------------------

describe('StreamingResponseService.buildLLMMessages — field preservation', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preserves tool_calls and tool_call_id through the real openrouter context builder', () => {
    const svc = new StreamingResponseService(makeStreamingDeps());
    const messages = callBuildLLMMessages(svc, makeToolCallConversation(), 'openrouter', 'system prompt');

    const assistantWithCalls = messages.filter((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantWithCalls).toHaveLength(1);
    expect(assistantWithCalls[0].tool_calls?.[0].id).toBe('call_abc123');

    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);
    for (const tm of toolMessages) {
      expect(tm.tool_call_id).toBe('call_abc123');
    }

    // The assistant's tool_calls[i].id must match the tool message's tool_call_id
    expect(assistantWithCalls[0].tool_calls?.[0].id).toBe(toolMessages[0].tool_call_id);
  });

  it('preserves reasoning_details, thought_signature, and name from context-builder output', () => {
    jest
      .spyOn(ConversationContextBuilder, 'buildContextForProvider')
      .mockReturnValue(makeRichContextMessages() as unknown as ReturnType<typeof ConversationContextBuilder.buildContextForProvider>);

    const svc = new StreamingResponseService(makeStreamingDeps());
    const messages = callBuildLLMMessages(svc, makeToolCallConversation(), 'openrouter', 'sys prompt');

    const assistant = messages.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistant).toBeDefined();
    expect(assistant?.reasoning_details).toEqual([
      { type: 'reasoning.text', text: 'Considering Paris weather...' },
    ]);
    expect(assistant?.thought_signature).toBe('sig-gemini-001');

    const tool = messages.find((m) => m.role === 'tool');
    expect(tool?.tool_call_id).toBe('call_abc123');
    expect(tool?.name).toBe('get_weather');
  });

  it('preserves an empty-string tool_call_id (downstream synthesis owns the policy)', () => {
    jest
      .spyOn(ConversationContextBuilder, 'buildContextForProvider')
      .mockReturnValue([
        { role: 'tool', content: '{}', tool_call_id: '' },
      ] as unknown as ReturnType<typeof ConversationContextBuilder.buildContextForProvider>);

    const svc = new StreamingResponseService(makeStreamingDeps());
    const messages = callBuildLLMMessages(svc, makeToolCallConversation(), 'openrouter');

    expect(messages).toHaveLength(1);
    expect(messages[0].tool_call_id).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 2. generateResponse — messages reach the llmService boundary intact
// ---------------------------------------------------------------------------

describe('StreamingResponseService.generateResponse — llmService boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes buildLLMMessages output to generateResponseStream with all fields intact', async () => {
    jest
      .spyOn(ConversationContextBuilder, 'buildContextForProvider')
      .mockReturnValue(makeRichContextMessages() as unknown as ReturnType<typeof ConversationContextBuilder.buildContextForProvider>);

    let captured: LLMConversationMessage[] | undefined;
    const deps = makeStreamingDeps({
      generateResponseStream: async function* (messages) {
        captured = messages;
        yield { chunk: 'Tokyo is sunny.', complete: true };
      },
      getConversation: jest.fn(async () => makeToolCallConversation()),
    });

    const svc = new StreamingResponseService(deps);
    const chunks: Array<{ chunk: string; complete: boolean }> = [];
    for await (const chunk of svc.generateResponse('conv-pipeline', 'Now check Tokyo.', {
      provider: 'openrouter',
      model: 'test-model',
      systemPrompt: 'sys prompt',
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.complete)).toBe(true);
    expect(captured).toBeDefined();

    const assistant = captured?.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistant).toBeDefined();
    expect(assistant?.tool_calls?.[0].id).toBe('call_abc123');
    expect(assistant?.reasoning_details).toEqual([
      { type: 'reasoning.text', text: 'Considering Paris weather...' },
    ]);
    expect(assistant?.thought_signature).toBe('sig-gemini-001');

    const tool = captured?.find((m) => m.role === 'tool');
    expect(tool?.tool_call_id).toBe('call_abc123');
    expect(tool?.name).toBe('get_weather');
  });
});

// ---------------------------------------------------------------------------
// 3. LLMService.generateResponseStream — passthrough to the orchestrator
// ---------------------------------------------------------------------------

describe('LLMService.generateResponseStream — orchestrator passthrough (Phase 3)', () => {
  beforeEach(() => {
    mockOrchestratorCalls.length = 0;
  });

  function makeLLMService(): LLMService {
    const settings: LLMProviderSettings = {
      providers: {},
      defaultModel: { provider: 'openrouter', model: 'test-model' },
    };
    return new LLMService(settings);
  }

  it('forwards the exact same messages array to the orchestrator (no remap)', async () => {
    const service = makeLLMService();
    const input = makeRichContextMessages();

    const chunks: Array<{ chunk: string; complete: boolean }> = [];
    for await (const chunk of service.generateResponseStream(input, { provider: 'openrouter', model: 'test-model' })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(mockOrchestratorCalls).toHaveLength(1);

    // Same array reference — a reintroduced `.map()` breaks this assertion.
    expect(mockOrchestratorCalls[0].messages).toBe(input);
    // And the same message objects, untouched.
    input.forEach((msg, i) => {
      expect(mockOrchestratorCalls[0].messages[i]).toBe(msg);
    });
  });

  it('delivers tool_call_id, tool_calls, and reasoning fields intact at the orchestrator boundary', async () => {
    const service = makeLLMService();
    const input = makeRichContextMessages();

    for await (const chunk of service.generateResponseStream(input, {})) {
      void chunk;
    }

    const received = mockOrchestratorCalls[0].messages;
    const assistant = received.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistant?.tool_calls?.[0].id).toBe('call_abc123');
    expect(assistant?.tool_calls?.[0].function?.name).toBe('get_weather');
    expect(assistant?.reasoning_details).toEqual([
      { type: 'reasoning.text', text: 'Considering Paris weather...' },
    ]);
    expect(assistant?.thought_signature).toBe('sig-gemini-001');

    const tool = received.find((m) => m.role === 'tool');
    expect(tool?.tool_call_id).toBe('call_abc123');
    expect(tool?.name).toBe('get_weather');
    service.dispose();
  });
});
