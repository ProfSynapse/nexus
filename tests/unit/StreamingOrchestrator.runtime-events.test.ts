/**
 * Runtime producer contract: if orchestration regresses to forwarding provider
 * `complete` flags as turn completion, the tool-boundary assertions go red.
 */
import type { BaseAdapter } from '../../src/services/llm/adapters/BaseAdapter';
import type { StreamChunk } from '../../src/services/llm/adapters/types';
import type { IAdapterRegistry } from '../../src/services/llm/core/AdapterRegistry';
import { StreamingOrchestrator } from '../../src/services/llm/core/StreamingOrchestrator';
import type { ChatRuntimeEvent } from '../../src/services/llm/runtime/ChatRuntimeEvent';
import { createInitialChatTurnState, reduceChatTurn } from '../../src/services/llm/runtime/ChatTurnReducer';
import type { LLMProviderSettings } from '../../src/types';
import type { IToolExecutor } from '../../src/services/llm/adapters/shared/ToolExecutionUtils';

function adapterWith(chunks: StreamChunk[]): BaseAdapter {
  return {
    async *generateStreamAsync() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as BaseAdapter;
}

function adapterWithResponses(responses: StreamChunk[][]): BaseAdapter {
  let responseIndex = 0;
  return {
    async *generateStreamAsync() {
      const response = responses[responseIndex++] || [];
      for (const chunk of response) {
        yield chunk;
      }
    },
  } as unknown as BaseAdapter;
}

function registryWith(adapter: BaseAdapter): IAdapterRegistry {
  return {
    initialize: jest.fn(),
    updateSettings: jest.fn(),
    getAdapter: jest.fn(() => adapter),
    getAvailableProviders: jest.fn(() => ['openrouter']),
    isProviderAvailable: jest.fn(() => true),
    clear: jest.fn(),
  };
}

function settings(): LLMProviderSettings {
  return {
    providers: {},
    defaultModel: { provider: 'openrouter', model: 'test-model' },
  };
}

async function collect(orchestrator: StreamingOrchestrator): Promise<ChatRuntimeEvent[]> {
  const events: ChatRuntimeEvent[] = [];
  for await (const event of orchestrator.generateResponseStream([
    { role: 'user', content: 'hello' },
  ])) {
    events.push(event);
  }
  return events;
}

describe('StreamingOrchestrator canonical runtime events', () => {
  it('emits provider response completion before exactly one terminal turn event', async () => {
    const orchestrator = new StreamingOrchestrator(
      registryWith(adapterWith([
        { content: 'Hel', complete: false },
        {
          content: 'lo',
          complete: true,
          usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
          metadata: { responseId: 'response-1' },
        },
      ])),
      settings()
    );

    const events = await collect(orchestrator);
    expect(events.map(event => event.type)).toEqual([
      'response.resolved',
      'assistant.delta',
      'assistant.delta',
      'usage.updated',
      'response.metadata',
      'response.completed',
      'turn.completed',
    ]);
    expect(events.filter(event => event.type.startsWith('turn.'))).toHaveLength(1);
  });

  it('fails loudly when a provider stream ends without a response boundary', async () => {
    const orchestrator = new StreamingOrchestrator(
      registryWith(adapterWith([{ content: 'partial', complete: false }])),
      settings()
    );

    await expect(collect(orchestrator)).rejects.toThrow(
      "Provider 'openrouter' ended its stream without a response.completed event."
    );
  });

  it('keeps a tool response boundary non-terminal and settles once after continuation', async () => {
    const toolCall = {
      id: 'call-1',
      type: 'function' as const,
      function: { name: 'content_read', arguments: '{"path":"note.md"}' },
    };
    const adapter = adapterWithResponses([
      [{ content: '', complete: true, toolCalls: [toolCall], toolCallsReady: true }],
      [{ content: 'Done', complete: true }],
    ]);
    const toolExecutor: IToolExecutor = {
      executeToolCalls: jest.fn(async () => [{
        id: 'call-1',
        name: 'content_read',
        success: true,
        result: { content: 'note' },
      }]),
    };
    const orchestrator = new StreamingOrchestrator(
      registryWith(adapter),
      settings(),
      toolExecutor
    );

    const events: ChatRuntimeEvent[] = [];
    for await (const event of orchestrator.generateResponseStream(
      [{ role: 'user', content: 'read it' }],
      {
        tools: [{
          type: 'function',
          function: {
            name: 'content_read',
            description: 'Read a note.',
            parameters: { type: 'object' },
          },
        }],
      }
    )) {
      events.push(event);
    }

    expect(events.filter(event => event.type === 'response.completed')).toHaveLength(2);
    expect(events.filter(event => event.type.startsWith('turn.'))).toEqual([
      { type: 'turn.completed' },
    ]);
    expect(events.some(event => event.type === 'tool.execution.started')).toBe(true);
    expect(events.some(event => event.type === 'tool.execution.completed')).toBe(true);
    expect(events.some(event => event.type === 'assistant.delta' && event.text === 'Done')).toBe(true);
  });

  it('passes exact Anthropic native search blocks into the client tool continuation', async () => {
    const raw = [
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', encrypted_content: 'opaque' }] },
      { type: 'tool_use', id: 'toolu_1', name: 'content_read', input: { path: 'note.md' } },
    ];
    const optionsSeen: unknown[] = [];
    const adapter = {
      async *generateStreamAsync(_prompt: string, options: unknown) {
        optionsSeen.push(options);
        if (optionsSeen.length === 1) {
          yield { content: '', complete: true, toolCalls: [{ id: 'toolu_1', type: 'function' as const, function: { name: 'content_read', arguments: '{"path":"note.md"}' } }], metadata: { anthropicResponseContent: raw } };
        } else {
          yield { content: 'Done', complete: true, metadata: { anthropicResponseContent: [{ type: 'text', text: 'Done' }] } };
        }
      },
    } as BaseAdapter;
    const orchestrator = new StreamingOrchestrator(
      registryWith(adapter),
      { providers: {}, defaultModel: { provider: 'anthropic', model: 'claude-sonnet-4-6' } },
      { executeToolCalls: jest.fn(async () => [{ id: 'toolu_1', name: 'content_read', success: true, result: { content: 'note' } }]) }
    );
    const events = await collectWithOptions(orchestrator, {
      tools: [{ type: 'function', function: { name: 'content_read', description: 'Read a note.', parameters: { type: 'object' } } }],
    });
    expect(optionsSeen).toHaveLength(2);
    expect((optionsSeen[1] as { conversationHistory: Array<{ role: string; content: unknown }> }).conversationHistory).toContainEqual({ role: 'assistant', content: raw });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.snapshot', calls: [expect.objectContaining({ anthropic_response_content: raw })] }));
  });

  it('increments operation sequence when a provider reuses a synthesized tool id', async () => {
    const repeatedCall = {
      id: 'google-tool_0',
      type: 'function' as const,
      function: { name: 'content_read', arguments: '{"path":"note.md"}' },
    };
    const adapter = adapterWithResponses([
      [{ content: '', complete: true, toolCalls: [repeatedCall], toolCallsReady: true }],
      [{ content: '', complete: true, toolCalls: [repeatedCall], toolCallsReady: true }],
      [{ content: 'Done', complete: true }],
    ]);
    const executeToolCalls = jest.fn(async () => [{
      id: 'google-tool_0', name: 'content_read', success: true, result: { content: 'note' },
    }]);
    const orchestrator = new StreamingOrchestrator(
      registryWith(adapter),
      settings(),
      { executeToolCalls }
    );

    await collectWithOptions(orchestrator, {
      turnId: 'turn-1',
      messageId: 'turn-1',
      tools: [{
        type: 'function',
        function: { name: 'content_read', description: 'Read a note.', parameters: { type: 'object' } },
      }],
    });

    expect(executeToolCalls.mock.calls.map(call => call[1]?.operationSequence)).toEqual([0, 1]);
  });

  it('refuses to dispatch more than 25 tool-bearing responses and warns the user', async () => {
    const repeatedCall = {
      id: 'repeated_0',
      type: 'function' as const,
      function: { name: 'content_read', arguments: '{"path":"note.md"}' },
    };
    const adapter = adapterWithResponses(Array.from({ length: 26 }, () => [
      { content: '', complete: true, toolCalls: [repeatedCall], toolCallsReady: true },
    ]));
    const executeToolCalls = jest.fn(async () => [{
      id: repeatedCall.id, name: 'content_read', success: true, result: { content: 'note' },
    }]);
    const orchestrator = new StreamingOrchestrator(
      registryWith(adapter),
      settings(),
      { executeToolCalls }
    );

    const events = await collectWithOptions(orchestrator, {
      turnId: 'turn-limit',
      tools: [{
        type: 'function',
        function: { name: 'content_read', description: 'Read a note.', parameters: { type: 'object' } },
      }],
    });

    expect(executeToolCalls).toHaveBeenCalledTimes(25);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'assistant.delta',
      text: expect.stringContaining("I've paused after 25 tool calls."),
    }));
  });

  it('waits for confirmation, resumes pending calls once, and asks again after 25 more iterations', async () => {
    const responses = Array.from({ length: 51 }, (_, index): StreamChunk[] => [{
      content: '', complete: true, toolCallsReady: true,
      toolCalls: [{ id: `call-${index}`, type: 'function',
        function: { name: 'content_read', arguments: '{}' } }],
    }]);
    const executeToolCalls = jest.fn<ReturnType<NonNullable<IToolExecutor['executeToolCalls']>>, Parameters<NonNullable<IToolExecutor['executeToolCalls']>>>(
      calls => Promise.resolve(calls.map(call => ({ id: call.id, name: 'content_read', success: true, result: {} })))
    );
    let allowContinue: (continueRun: boolean) => void = () => { throw new Error('Confirmation not reached'); };
    let reachedCheckpoint: () => void = () => {};
    const checkpoint = new Promise<void>(resolve => { reachedCheckpoint = resolve; });
    const onToolLimitReached = jest.fn((completed: number) => {
      if (completed === 25) {
        reachedCheckpoint();
        return new Promise<boolean>(resolve => { allowContinue = resolve; });
      }
      return Promise.resolve(false);
    });
    const orchestrator = new StreamingOrchestrator(registryWith(adapterWithResponses(responses)), settings(), { executeToolCalls });
    const result = collectWithOptions(orchestrator, {
      onToolLimitReached,
      tools: [{ type: 'function', function: { name: 'content_read', description: 'Read', parameters: { type: 'object' } } }],
    });

    await checkpoint;
    expect(executeToolCalls).toHaveBeenCalledTimes(25);
    allowContinue(true);
    const events = await result;
    expect(onToolLimitReached.mock.calls.map(call => call[0])).toEqual([25, 50]);
    expect(executeToolCalls.mock.calls.map(call => call[0][0].id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `call-${index}`)
    );
    expect(executeToolCalls.mock.calls.map(call => call[1]?.operationSequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => index)
    );
    expect(events.filter(event => event.type.startsWith('turn.'))).toEqual([
      { type: 'turn.aborted', reason: 'Stopped by user' },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.snapshot', calls: expect.arrayContaining([
      expect.objectContaining({ id: 'call-49', success: true }),
    ]) }));
  }, 15000);

  it('aborts promptly while confirmation is pending without dispatching more tools', async () => {
    const repeatedCall = { id: 'call-1', type: 'function' as const,
      function: { name: 'content_read', arguments: '{}' } };
    const executeToolCalls = jest.fn(() => Promise.resolve([
      { id: repeatedCall.id, name: 'content_read', success: true, result: {} },
    ]));
    const controller = new AbortController();
    const onToolLimitReached = jest.fn(() => {
      controller.abort();
      return new Promise<boolean>(() => {});
    });
    const orchestrator = new StreamingOrchestrator(
      registryWith(adapterWithResponses(Array.from({ length: 26 }, () => [
        { content: '', complete: true, toolCallsReady: true, toolCalls: [repeatedCall] },
      ]))), settings(), { executeToolCalls }
    );
    const events = await collectWithOptions(orchestrator, {
      abortSignal: controller.signal, onToolLimitReached,
      tools: [{ type: 'function', function: { name: 'content_read', description: 'Read', parameters: { type: 'object' } } }],
    });
    expect(executeToolCalls).toHaveBeenCalledTimes(25);
    expect(events.at(-1)).toEqual({ type: 'turn.aborted', reason: 'Stopped by user' });
    expect(events.some(event => event.type === 'turn.completed')).toBe(false);
  });

  it.each([30, 24])('pauses at exactly 25 individual calls when a batch crosses the allowance (initial batch: %s)', async (initialCount) => {
    const calls = Array.from({ length: 30 }, (_, index) => ({
      id: `batched-${index}`, type: 'function' as const,
      function: { name: 'content_read', arguments: '{}' },
    }));
    const responses: StreamChunk[][] = [[{
      content: '', complete: true, toolCallsReady: true, toolCalls: calls.slice(0, initialCount),
    }]];
    if (initialCount < calls.length) responses.push([{
      content: '', complete: true, toolCallsReady: true, toolCalls: calls.slice(initialCount),
    }]);
    responses.push([{ content: 'Finished', complete: true }]);
    const dispatched: string[] = [];
    const executeToolCalls: IToolExecutor['executeToolCalls'] = batch => {
      dispatched.push(...batch.map(call => call.id));
      return Promise.resolve(batch.map(call => ({ id: call.id, name: 'content_read', success: true, result: {} })));
    };
    let continueRun: (decision: boolean) => void = () => { throw new Error('Checkpoint not reached'); };
    let checkpointReached: () => void = () => {};
    const checkpoint = new Promise<void>(resolve => { checkpointReached = resolve; });
    const onToolLimitReached = jest.fn(() => {
      checkpointReached();
      return new Promise<boolean>(resolve => { continueRun = resolve; });
    });
    const adapter = adapterWithResponses(responses);
    const stream = jest.spyOn(adapter, 'generateStreamAsync');
    const result = collectWithOptions(new StreamingOrchestrator(registryWith(adapter), settings(), { executeToolCalls }), {
      onToolLimitReached,
      tools: [{ type: 'function', function: { name: 'content_read', description: 'Read', parameters: { type: 'object' } } }],
    });

    await checkpoint;
    expect(dispatched).toEqual(calls.slice(0, 25).map(call => call.id));
    expect(onToolLimitReached).toHaveBeenCalledWith(25, undefined);
    continueRun(true);
    const events = await result;
    expect(dispatched).toEqual(calls.map(call => call.id));
    expect(onToolLimitReached).toHaveBeenCalledTimes(1);
    const finalHistory = stream.mock.calls.at(-1)?.[1]?.conversationHistory;
    expect(finalHistory?.filter(message => message.role === 'tool')).toHaveLength(30);
    expect(events.at(-1)).toEqual({ type: 'turn.completed' });
  });

  it.each([false, true])('discards the unexecuted batch tail on fallback or terminal handoff (terminal: %s)', async (terminal) => {
    const calls = Array.from({ length: 30 }, (_, index) => ({
      id: `call-${index}`, type: 'function' as const,
      function: { name: terminal && index === 24 ? 'prompt_subagent' : 'content_read', arguments: '{}' },
    }));
    const executed: string[] = [];
    const executeToolCalls: IToolExecutor['executeToolCalls'] = batch => {
      executed.push(...batch.map(call => call.id));
      return Promise.resolve(batch.map(call => ({
        id: call.id, name: call.function.name, success: true,
        result: terminal && call.id === 'call-24' ? { success: true, data: { branchId: 'branch-1' } } : {},
      })));
    };
    const onToolLimitReached = jest.fn(() => Promise.resolve(true));
    const events = await collectWithOptions(new StreamingOrchestrator(
      registryWith(adapterWithResponses([[{ content: '', complete: true, toolCallsReady: true, toolCalls: calls }]])),
      settings(), { executeToolCalls }
    ), {
      onToolLimitReached: terminal ? onToolLimitReached : undefined,
      tools: [{ type: 'function', function: { name: 'content_read', description: 'Read', parameters: { type: 'object' } } }],
    });
    expect(executed).toEqual(calls.slice(0, 25).map(call => call.id));
    expect(onToolLimitReached).not.toHaveBeenCalled();
    const state = events.reduce(reduceChatTurn, createInitialChatTurnState());
    expect(state.toolCalls).toHaveLength(25);
    expect(state.toolCalls.every(call => call.success === true)).toBe(true);
    expect(state.phase).toBe('complete');
    expect(state.content).toContain(terminal ? 'Subagent Started' : "I've paused after 25 tool calls.");
  });
});

async function collectWithOptions(
  orchestrator: StreamingOrchestrator,
  options: Record<string, unknown>
): Promise<ChatRuntimeEvent[]> {
  const events: ChatRuntimeEvent[] = [];
  for await (const event of orchestrator.generateResponseStream(
    [{ role: 'user', content: 'hello' }],
    options
  )) {
    events.push(event);
  }
  return events;
}
