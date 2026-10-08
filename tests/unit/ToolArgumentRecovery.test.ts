import type { BaseAdapter } from '../../src/services/llm/adapters/BaseAdapter';
import type { GenerateOptions, StreamChunk } from '../../src/services/llm/adapters/types';
import { DirectToolExecutor } from '../../src/services/chat/DirectToolExecutor';
import { AnthropicContextBuilder } from '../../src/services/chat/builders/AnthropicContextBuilder';
import type { LLMMessage } from '../../src/services/chat/builders/IContextBuilder';
import { ProviderMessageBuilder } from '../../src/services/llm/core/ProviderMessageBuilder';
import { ToolContinuationService } from '../../src/services/llm/core/ToolContinuationService';
import type { ChatRuntimeEvent } from '../../src/services/llm/runtime/ChatRuntimeEvent';
import type { ToolCall } from '../../src/types/chat/ChatTypes';

const malformedArguments = '{"tool":"content read" "path":"note.md"}';

function call(id: string, argumentsJson: string): ToolCall {
  return {
    id,
    type: 'function',
    function: { name: 'content_read', arguments: argumentsJson },
  };
}

function realExecutor(): DirectToolExecutor {
  return new DirectToolExecutor({
    agentProvider: {
      getAllAgents: () => [],
    } as ConstructorParameters<typeof DirectToolExecutor>[0]['agentProvider'],
  });
}

function adapterWithResponses(responses: StreamChunk[][], histories: unknown[]): BaseAdapter {
  let nextResponse = 0;
  return {
    async *generateStreamAsync(_prompt: string, options: GenerateOptions) {
      histories.push(options.conversationHistory);
      for (const chunk of responses[nextResponse++] ?? []) {
        yield chunk;
      }
    },
  } as unknown as BaseAdapter;
}

async function collect(
  service: ToolContinuationService,
  adapter: BaseAdapter,
  initialCalls: ToolCall[]
): Promise<ChatRuntimeEvent[]> {
  const events: ChatRuntimeEvent[] = [];
  for await (const event of service.executeToolsAndContinue(
    adapter,
    'anthropic',
    initialCalls,
    [],
    'Read the note',
    { model: 'test-claude' },
    { sessionId: 'session-1', workspaceId: 'workspace-1' }
  )) {
    events.push(event);
  }
  return events;
}

describe('Anthropic malformed tool argument recovery', () => {
  it('continues mixed calls, preserves raw arguments, and executes only the corrected recursive call', async () => {
    const executor = realExecutor();
    const executeTool = jest.spyOn(executor, 'executeTool').mockResolvedValue({ success: true, content: 'note' });
    const histories: unknown[] = [];
    const adapter = adapterWithResponses([
      [{ content: '', complete: true, toolCalls: [call('retry-1', '{"path":"fixed.md"}')] }],
      [{ content: 'Done', complete: true }],
    ], histories);
    const service = new ToolContinuationService(executor, new ProviderMessageBuilder(new Map()));

    const events = await collect(service, adapter, [
      call('valid-1', '{"path":"note.md"}'),
      call('bad-1', malformedArguments),
    ]);

    expect(events.at(-1)).toEqual({ type: 'turn.completed' });
    expect(events.some(event => event.type === 'turn.failed')).toBe(false);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool.mock.calls.map((args) => args[1])).toEqual([
      { path: 'note.md' },
      { path: 'fixed.md' },
    ]);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.snapshot',
      calls: expect.arrayContaining([
        expect.objectContaining({ id: 'bad-1', success: false,
          function: expect.objectContaining({ arguments: malformedArguments }) }),
      ]),
    }));

    const firstHistory = histories[0] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const firstToolUses = firstHistory.find(message => message.role === 'assistant')?.content ?? [];
    expect(firstToolUses).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use', id: 'bad-1', input: {} }),
    ]));
    const firstResults = firstHistory.find(message => message.role === 'user' && Array.isArray(message.content))?.content ?? [];
    expect(firstResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'bad-1', is_error: true,
        content: expect.stringContaining('Retry this call with valid JSON arguments') }),
    ]));
  });

  it('bounds repeated malformed recursive calls at the existing 15-response limit', async () => {
    const executor = realExecutor();
    const executeTool = jest.spyOn(executor, 'executeTool');
    const histories: unknown[] = [];
    const responses = Array.from({ length: 15 }, (_, index): StreamChunk[] => [{
      content: '',
      complete: true,
      toolCalls: [call(`bad-${index + 1}`, malformedArguments)],
    }]);
    const service = new ToolContinuationService(
      executor,
      new ProviderMessageBuilder(new Map())
    );
    const events = await collect(service, adapterWithResponses(responses, histories), [
      call('bad-0', malformedArguments),
    ]);

    expect(executeTool).not.toHaveBeenCalled();
    expect(events.filter(event => event.type === 'tool.execution.completed')).toHaveLength(15);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'assistant.delta',
      text: expect.stringContaining('TOOL_LIMIT_REACHED'),
    }));
    expect(events.at(-1)).toEqual({ type: 'turn.completed' });
  });

  it('appends a malformed call as an errored Anthropic tool result', () => {
    const builder = new AnthropicContextBuilder();
    const messages = builder.appendToolExecution(
      [call('bad-1', malformedArguments)],
      [{ id: 'bad-1', success: false, error: 'Invalid tool arguments' }],
      [] as LLMMessage[]
    );

    expect(messages).toEqual([
      { role: 'assistant', content: [expect.objectContaining({
        type: 'tool_use', id: 'bad-1', input: {},
      })] },
      { role: 'user', content: [expect.objectContaining({
        type: 'tool_result', tool_use_id: 'bad-1', is_error: true,
      })] },
    ]);
  });
});
