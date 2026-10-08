import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import type { BaseAdapter } from '../../src/services/llm/adapters/BaseAdapter';
import type { GenerateOptions, StreamChunk } from '../../src/services/llm/adapters/types';
import { MistralAdapter } from '../../src/services/llm/adapters/mistral/MistralAdapter';
import { RequestyAdapter } from '../../src/services/llm/adapters/requesty/RequestyAdapter';
import { DirectToolExecutor } from '../../src/services/chat/DirectToolExecutor';
import { StreamingResponseService } from '../../src/services/chat/StreamingResponseService';
import { ConversationContextBuilder } from '../../src/services/chat/ConversationContextBuilder';
import { ProviderMessageBuilder } from '../../src/services/llm/core/ProviderMessageBuilder';
import { ToolContinuationService } from '../../src/services/llm/core/ToolContinuationService';
import type { ChatRuntimeEvent } from '../../src/services/llm/runtime/ChatRuntimeEvent';
import { createInitialChatTurnState, reduceChatTurn } from '../../src/services/llm/runtime/ChatTurnReducer';
import { mapProviderStreamChunk } from '../../src/services/llm/runtime/ProviderStreamEventMapper';
import type { ConversationData, ToolCall } from '../../src/types/chat/ChatTypes';
import { createAssistantMessage, createConversation, createUserMessage } from '../fixtures/chatBugs';
import { collect, sse, sseResponse } from './helpers/llmAdapterTestHarness';

const firstContent: Array<Record<string, unknown>> = [
  { type: 'thinking', thinking: [{ type: 'text', text: 'Find the note.' }] },
  { type: 'text', text: 'I will read it.' },
];
const secondContent: Array<Record<string, unknown>> = [
  { type: 'thinking', thinking: [{ type: 'text', text: 'Read another note.' }] },
  { type: 'text', text: 'I will check again.' },
];

function responseMetadata(
  records: Array<{ content: string | Array<Record<string, unknown>>; toolCallIds: string[] }>,
  visibleContent = ''
) {
  const events: ChatRuntimeEvent[] = [
    ...(visibleContent ? [{ type: 'assistant.delta', text: visibleContent } as const] : []),
    ...records.flatMap(record => mapProviderStreamChunk({
    content: '', complete: true, metadata: { mistralResponse: record },
    })),
  ];
  const state = events.reduce(reduceChatTurn, createInitialChatTurnState());
  expect(state.metadata).not.toHaveProperty('mistralResponse');
  return state.metadata;
}

function toolCall(id: string, path: string, content: Array<Record<string, unknown>>): ToolCall {
  return {
    id,
    type: 'function',
    function: { name: 'content_read', arguments: JSON.stringify({ path }) },
    mistral_assistant_content: content,
  };
}

function realExecutor(): DirectToolExecutor {
  return new DirectToolExecutor({
    agentProvider: {
      getAllAgents: () => [],
    } as ConstructorParameters<typeof DirectToolExecutor>[0]['agentProvider'],
  });
}

describe.each([
  ['mistral', 'mistral-large-4'],
  ['requesty', 'mistral/mistral-large-4'],
])('%s Mistral Large 4 recursive tool continuation', (provider, model) => {
  it('replays each original typed assistant response and retains it on final tool calls', async () => {
    const executor = realExecutor();
    const executeTool = jest.spyOn(executor, 'executeTool').mockResolvedValue({ success: true, content: 'note' });
    const histories: Array<Array<Record<string, unknown>> | undefined> = [];
    const responses: StreamChunk[][] = [
      [{ content: '', complete: true, toolCalls: [toolCall('call-2', 'second.md', secondContent)] }],
      [{ content: 'Done', complete: true }],
    ];
    let responseIndex = 0;
    const adapter = {
      async *generateStreamAsync(_prompt: string, options: GenerateOptions) {
        histories.push(options.conversationHistory);
        for (const chunk of responses[responseIndex++] ?? []) yield chunk;
      },
    } as unknown as BaseAdapter;
    const service = new ToolContinuationService(executor, new ProviderMessageBuilder(new Map()));

    const events: ChatRuntimeEvent[] = [];
    for await (const event of service.executeToolsAndContinue(
      adapter,
      provider,
      [toolCall('call-1', 'first.md', firstContent)],
      [],
      'Read both notes',
      { model },
      { sessionId: 'session-1', workspaceId: 'workspace-1' }
    )) events.push(event);

    expect(events.at(-1)).toEqual({ type: 'turn.completed' });
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(histories).toHaveLength(2);
    const assistantTurns = (history: Array<Record<string, unknown>> | undefined) =>
      history?.filter(message => message.role === 'assistant') ?? [];
    expect(assistantTurns(histories[0]).map(message => message.content)).toEqual([firstContent]);
    expect(assistantTurns(histories[1]).map(message => message.content)).toEqual([firstContent, secondContent]);

    const finalSnapshot = events.filter(event => event.type === 'tool.snapshot').at(-1);
    expect(finalSnapshot).toEqual(expect.objectContaining({
      calls: expect.arrayContaining([
        expect.objectContaining({ id: 'call-1', mistral_assistant_content: firstContent }),
        expect.objectContaining({ id: 'call-2', mistral_assistant_content: secondContent }),
      ]),
    }));
  });
});

describe('Requesty stored Mistral assistant content', () => {
  it.each([
    ['mistral/mistral-large-4', firstContent],
    ['openai/gpt-5.5', 'I will read it.'],
  ])('uses the selected model %s to build stored conversation history', async (model, expectedContent) => {
    const stored = createConversation({ messages: [
      createUserMessage({ id: 'user-1', content: 'Read a note' }),
      createAssistantMessage({
        id: 'assistant-1', content: 'I will read it.', state: 'complete',
        toolCalls: [],
        metadata: { mistralAssistantContent: firstContent },
      }),
      createUserMessage({ id: 'user-2', content: 'Now summarize it' }),
    ] });
    let sentMessages: unknown;
    const dependencies = {
      llmService: {
        getDefaultModel: () => ({ provider: 'requesty', model: 'openai/gpt-5.5' }),
        async *generateResponseStream(messages: unknown) {
          sentMessages = messages;
          yield { type: 'assistant.delta', text: 'Done' } as const;
          yield { type: 'turn.completed' } as const;
        },
      },
      conversationService: {
        getConversation: jest.fn(async () => stored),
        addMessage: jest.fn(async () => undefined),
        updateConversation: jest.fn(async (_id: string, _update: { messages?: ConversationData['messages'] }) => undefined),
      },
      toolCallService: {
        getAvailableTools: jest.fn(() => []),
        resetDetectedTools: jest.fn(),
        handleToolCallDetection: jest.fn(),
        fireToolEvent: jest.fn(),
      },
      costTrackingService: {
        createUsageCallback: jest.fn(() => jest.fn()),
        extractUsage: jest.fn(),
        trackMessageUsage: jest.fn(),
      },
    };
    const service = new StreamingResponseService(
      dependencies as unknown as ConstructorParameters<typeof StreamingResponseService>[0]
    );

    for await (const _envelope of service.generateResponse('conversation-1', 'Now summarize it', {
      provider: 'requesty', model,
    })) { /* Drain the real streaming service to its persistence boundary. */ }

    expect(sentMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: expectedContent }),
    ]));
  });

  it.each([
    ['mistral', 'mistral-large-4'],
    ['requesty', 'mistral/mistral-large-4'],
  ])('replays two %s tool rounds and the final answer in order', (provider, model) => {
    const finalContent = [
      { type: 'thinking', thinking: [{ type: 'text', text: 'Both notes agree.' }] },
      { type: 'text', text: 'Final answer: 42' },
    ];
    const stored = createConversation({ messages: [
      createUserMessage({ id: 'user-1', content: 'Read both notes' }),
      createAssistantMessage({
        id: 'assistant-1',
        content: 'I will read it.\n\nI will check again.\n\nFinal answer: 42',
        state: 'complete',
        toolCalls: [
          { ...toolCall('call_1', 'first.md', firstContent), result: { text: 'first' }, success: true },
          { ...toolCall('call_2', 'second.md', secondContent), result: { text: 'second' }, success: true },
        ],
        metadata: responseMetadata([
          { content: firstContent, toolCallIds: ['call_1'] },
          { content: secondContent, toolCallIds: ['call_2'] },
          { content: finalContent, toolCallIds: [] },
        ], 'I will read it.\n\nI will check again.\n\nFinal answer: 42'),
      }),
      createUserMessage({ id: 'user-2', content: 'What was the answer?' }),
    ] });

    const history = ConversationContextBuilder.buildContextForProvider(stored, provider, undefined, model);
    expect(history.map(message => message.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'user',
    ]);
    expect(history[1]).toEqual(expect.objectContaining({ content: firstContent,
      tool_calls: [expect.objectContaining({ id: 'call_1' })] }));
    expect(history[2]).toEqual(expect.objectContaining({ tool_call_id: 'call_1' }));
    expect(history[3]).toEqual(expect.objectContaining({ content: secondContent,
      tool_calls: [expect.objectContaining({ id: 'call_2' })] }));
    expect(history[4]).toEqual(expect.objectContaining({ tool_call_id: 'call_2' }));
    expect(history[5]).toEqual(expect.objectContaining({ content: finalContent }));
  });

  it('keeps plain combined history when switching the same stored conversation to another Requesty model', () => {
    const stored = createConversation({ messages: [
      createUserMessage({ id: 'user-1', content: 'Read both notes' }),
      createAssistantMessage({
        id: 'assistant-1', content: 'First round. Final answer: 42', state: 'complete',
        toolCalls: [{ ...toolCall('call-1', 'first.md', firstContent), result: { text: 'first' }, success: true }],
        metadata: { mistralAssistantContent: [{ type: 'text', text: 'Final answer: 42' }] },
      }),
      createUserMessage({ id: 'user-2', content: 'What was the answer?' }),
    ] });

    const history = ConversationContextBuilder.buildContextForProvider(
      stored, 'requesty', undefined, 'openai/gpt-5.5'
    );
    expect(history.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(history[1]).toEqual(expect.objectContaining({ content: 'First round. Final answer: 42' }));
  });

  it('keeps parallel calls in one assistant round and does not duplicate a terminal tool response', () => {
    const stored = createConversation({ messages: [
      createUserMessage({ id: 'user-1', content: 'Read two notes' }),
      createAssistantMessage({
        id: 'assistant-1', content: 'I will read them.', state: 'complete',
        toolCalls: [
          { ...toolCall('call_1', 'first.md', firstContent), result: { text: 'first' }, success: true },
          { ...toolCall('call_2', 'second.md', firstContent), result: { text: 'second' }, success: true },
        ],
        metadata: responseMetadata([{ content: firstContent, toolCallIds: ['call_1', 'call_2'] }], 'I will read them.'),
      }),
      createUserMessage({ id: 'user-2', content: 'Continue' }),
    ] });

    const history = ConversationContextBuilder.buildContextForProvider(
      stored, 'requesty', undefined, 'mistral/mistral-large-4'
    );
    expect(history.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
    expect(history[1]).toEqual(expect.objectContaining({
      content: firstContent,
      tool_calls: [
        expect.objectContaining({ id: 'call_1' }),
        expect.objectContaining({ id: 'call_2' }),
      ],
    }));
  });

  it('keeps identical consecutive tool rounds and an identical final response as three boundaries', () => {
    const stored = createConversation({ messages: [
      createUserMessage({ id: 'user-1', content: 'Try twice' }),
      createAssistantMessage({
        id: 'assistant-1', content: 'I will read it. I will read it. I will read it.', state: 'complete',
        toolCalls: [
          { ...toolCall('call_1', 'first.md', firstContent), result: 'first', success: true },
          { ...toolCall('call_2', 'second.md', firstContent), result: 'second', success: true },
        ],
        metadata: responseMetadata([
          { content: firstContent, toolCallIds: ['call_1'] },
          { content: firstContent, toolCallIds: ['call_2'] },
          { content: firstContent, toolCallIds: [] },
        ], 'I will read it. I will read it. I will read it.'),
      }),
      createUserMessage({ id: 'user-2', content: 'Continue' }),
    ] });
    const history = ConversationContextBuilder.buildContextForProvider(
      stored, 'mistral', undefined, 'mistral-large-4'
    );
    expect(history.map(message => message.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'user',
    ]);
    expect(history[1].content).toEqual(firstContent);
    expect(history[3].content).toEqual(firstContent);
    expect(history[5].content).toEqual(firstContent);
  });

  it('replays a plain Requesty final answer after typed tool rounds despite stale typed metadata', () => {
    const stored = createConversation({ messages: [
      createUserMessage({ id: 'user-1', content: 'Read a note' }),
      createAssistantMessage({
        id: 'assistant-1', content: 'I will read it. Final answer: 42', state: 'complete',
        toolCalls: [{ ...toolCall('call_1', 'first.md', firstContent), result: 'first', success: true }],
        metadata: {
          mistralAssistantContent: firstContent,
          ...responseMetadata([
            { content: firstContent, toolCallIds: ['call_1'] },
            { content: 'Final answer: 42', toolCallIds: [] },
          ], 'I will read it. Final answer: 42'),
        },
      }),
      createUserMessage({ id: 'user-2', content: 'Continue' }),
    ] });
    const history = ConversationContextBuilder.buildContextForProvider(
      stored, 'requesty', undefined, 'mistral/mistral-large-4'
    );
    expect(history.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(history[1].content).toEqual(firstContent);
    expect(history[3].content).toBe('Final answer: 42');
  });

  it('preserves an empty tool response boundary and the final answer', () => {
    const stored = createConversation({ messages: [
      createUserMessage({ id: 'user-1', content: 'Read both' }),
      createAssistantMessage({
        id: 'assistant-1', content: 'I will read it. Final answer: 42', state: 'complete',
        toolCalls: [
          { ...toolCall('call_1', 'first.md', firstContent), result: 'first', success: true },
          { ...toolCall('call_2', 'second.md', []), result: 'second', success: true },
        ],
        metadata: responseMetadata([
          { content: firstContent, toolCallIds: ['call_1'] },
          { content: '', toolCallIds: ['call_2'] },
          { content: 'Final answer: 42', toolCallIds: [] },
        ], 'I will read it. Final answer: 42'),
      }),
      createUserMessage({ id: 'user-2', content: 'Continue' }),
    ] });
    const history = ConversationContextBuilder.buildContextForProvider(
      stored, 'requesty', undefined, 'mistral/mistral-large-4'
    );
    expect(history.map(message => message.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'user',
    ]);
    expect(history[3].content).toBe('');
    expect(history[5].content).toBe('Final answer: 42');
  });

  it('preserves all visible answer text for incomplete legacy response records', () => {
    const fullText = 'First tool round. Final answer: 42';
    const stored = createConversation({ messages: [
      createUserMessage({ id: 'user-1', content: 'Read a note' }),
      createAssistantMessage({
        id: 'assistant-1', content: fullText, state: 'complete',
        toolCalls: [{ ...toolCall('call_1', 'first.md', firstContent), result: 'first', success: true }],
        metadata: responseMetadata([{ content: 'Final answer: 42', toolCallIds: [] }], fullText),
      }),
      createUserMessage({ id: 'user-2', content: 'Continue' }),
    ] });
    const history = ConversationContextBuilder.buildContextForProvider(
      stored, 'mistral', undefined, 'mistral-large-4'
    );
    expect(history.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(history[1].content).toBe(fullText);
  });

  it('retains a typed reasoning-only response with no visible text or tool calls', () => {
    const reasoningOnly = [{ type: 'thinking', thinking: [{ type: 'text', text: 'Still working.' }] }];
    const stored = createConversation({ messages: [
      createUserMessage({ id: 'user-1', content: 'Think' }),
      createAssistantMessage({
        id: 'assistant-1', content: '', state: 'complete', toolCalls: [],
        metadata: responseMetadata([{ content: reasoningOnly, toolCallIds: [] }]),
      }),
      createUserMessage({ id: 'user-2', content: 'Continue' }),
    ] });
    const history = ConversationContextBuilder.buildContextForProvider(
      stored, 'mistral', undefined, 'mistral-large-4'
    );
    expect(history.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(history[1].content).toEqual(reasoningOnly);
  });

  it.each([
    ['aborted partial response', 'I will read it. Partial answer', 'aborted' as const],
    ['synthetic tool-limit text', 'I will read it.\n\nTOOL_LIMIT_REACHED: ask the user to continue.', 'complete' as const],
  ])('keeps trailing visible text after %s', (_scenario, visibleContent, state) => {
    const stored = createConversation({ messages: [
      createUserMessage({ id: 'user-1', content: 'Read a note' }),
      createAssistantMessage({
        id: 'assistant-1', content: visibleContent, state,
        toolCalls: [{ ...toolCall('call_1', 'first.md', firstContent), result: 'first', success: true }],
        metadata: responseMetadata([{ content: firstContent, toolCallIds: ['call_1'] }], 'I will read it.'),
      }),
      createUserMessage({ id: 'user-2', content: 'Continue' }),
    ] });
    const history = ConversationContextBuilder.buildContextForProvider(
      stored, 'mistral', undefined, 'mistral-large-4'
    );
    expect(history.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(history[1].content).toBe(visibleContent);
  });
});

describe.each([
  ['mistral', () => new MistralAdapter('test-key', 'mistral-large-4')],
  ['requesty', () => new RequestyAdapter('test-key', 'mistral/mistral-large-4')],
])('%s complete-response metadata', (_provider, createAdapter) => {
  it('captures typed tool content and a later plain-text final as separate records', async () => {
    let request = 0;
    __setRequestUrlMock(async () => sseResponse(request++ === 0
      ? sse(
        { choices: [{ delta: { content: firstContent } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'content_read', arguments: '{}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]'
      )
      : sse(
        { choices: [{ delta: { content: 'Final answer: 42' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'
      )));

    const adapter = createAdapter();
    const first = await collect(adapter.generateStreamAsync('Read a note'));
    const second = await collect(adapter.generateStreamAsync('Continue'));
    expect(first.at(-1)?.metadata?.mistralResponse).toEqual({ content: firstContent, toolCallIds: ['call_1'] });
    expect(second.at(-1)?.metadata?.mistralResponse).toEqual({ content: 'Final answer: 42', toolCallIds: [] });

    const events = [...first, ...second].flatMap(mapProviderStreamChunk);
    const state = events.reduce(reduceChatTurn, createInitialChatTurnState());
    expect(state.metadata.mistralResponses).toEqual([
      expect.objectContaining({ content: firstContent, toolCallIds: ['call_1'] }),
      expect.objectContaining({ content: 'Final answer: 42', toolCallIds: [] }),
    ]);
    const records = state.metadata.mistralResponses as Array<{ contentEndOffset: number }>;
    expect(records[0].contentEndOffset).toBe('I will read it.'.length);
    expect(records[1].contentEndOffset).toBe(state.content.length);
  });
});
