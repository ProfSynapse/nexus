/**
 * Runtime producer contract: if orchestration regresses to forwarding provider
 * `complete` flags as turn completion, the tool-boundary assertions go red.
 */
import type { BaseAdapter } from '../../src/services/llm/adapters/BaseAdapter';
import type { StreamChunk } from '../../src/services/llm/adapters/types';
import type { IAdapterRegistry } from '../../src/services/llm/core/AdapterRegistry';
import { StreamingOrchestrator } from '../../src/services/llm/core/StreamingOrchestrator';
import type { ChatRuntimeEvent } from '../../src/services/llm/runtime/ChatRuntimeEvent';
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

  it('refuses to dispatch more than 15 recursive tool-bearing responses', async () => {
    const repeatedCall = {
      id: 'repeated_0',
      type: 'function' as const,
      function: { name: 'content_read', arguments: '{"path":"note.md"}' },
    };
    const adapter = adapterWithResponses(Array.from({ length: 16 }, () => [
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

    expect(executeToolCalls).toHaveBeenCalledTimes(15);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'assistant.delta',
      text: expect.stringContaining('TOOL_LIMIT_REACHED'),
    }));
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
