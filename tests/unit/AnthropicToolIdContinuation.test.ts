/**
 * If argument deltas replace Anthropic's tool_use IDs, the real stream →
 * orchestration → continuation request has orphaned tool_result IDs.
 * Only HTTP and tool side effects are fixtures; message construction is real.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';
jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'), hasNodeRuntime: () => false,
}));
import { AnthropicAdapter } from '../../src/services/llm/adapters/anthropic/AnthropicAdapter';
import { StreamingOrchestrator } from '../../src/services/llm/core/StreamingOrchestrator';
import type { IAdapterRegistry } from '../../src/services/llm/core/AdapterRegistry';
import type { IToolExecutor } from '../../src/services/llm/adapters/shared/ToolExecutionUtils';
import type { ChatRuntimeEvent } from '../../src/services/llm/runtime/ChatRuntimeEvent';
import { sse, sseResponse } from './helpers/llmAdapterTestHarness';

describe.each([false, true])('Anthropic tool ID replay (webSearch=%s)', webSearch => {
  it('keeps provider IDs through split arguments, parallel calls and recursive continuation', async () => {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const response = (ids: string[]) => sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-signature' } },
      { type: 'content_block_stop', index: 0 },
      // A live response can defer its native search result until the next
      // client-tool round. Keep that pair in the same uninterrupted user turn.
      ...(webSearch && ids[0] !== 'toolu_recursive' ? [
        { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"test"}' } },
        { type: 'content_block_stop', index: 1 },
      ] : []),
      ...(webSearch && ids[0] === 'toolu_recursive' ? [
        { type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] } },
        { type: 'content_block_stop', index: 2 },
      ] : []),
      ...ids.flatMap((id, i) => [
        { type: 'content_block_start', index: i + 3, content_block: { type: 'tool_use', id, name: 'lookup', input: {} } },
        { type: 'content_block_delta', index: i + 3, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
        { type: 'content_block_delta', index: i + 3, delta: { type: 'input_json_delta', partial_json: '"test"}' } },
        { type: 'content_block_stop', index: i + 3 },
      ]),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    );
    __setRequestUrlMock(async request => {
      requests.push(JSON.parse(request.body ?? '{}'));
      return sseResponse(requests.length === 1 ? response(['toolu_first', 'toolu_parallel'])
        : requests.length === 2 ? response(['toolu_recursive'])
          : sse(
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
            { type: 'message_stop' },
          ));
    });
    const adapter = new AnthropicAdapter('test-key', 'claude-opus-5-5');
    const registry: IAdapterRegistry = {
      initialize: jest.fn(), updateSettings: jest.fn(), clear: jest.fn(),
      getAdapter: () => adapter, getAvailableProviders: () => ['anthropic'], isProviderAvailable: () => true,
    };
    const executor: IToolExecutor = {
      executeToolCalls: jest.fn(async calls => calls.map(call => ({
        id: call.id, name: call.function.name, success: true, result: { found: true },
      }))),
    };
    const orchestrator = new StreamingOrchestrator(registry, {
      providers: {}, defaultModel: { provider: 'anthropic', model: 'claude-opus-5-5' },
    }, executor);
    const events: ChatRuntimeEvent[] = [];
    for await (const event of orchestrator.generateResponseStream([{ role: 'user', content: 'Look it up' }], {
      enableThinking: true, webSearch,
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up', parameters: { type: 'object' } } }],
    })) events.push(event);

    expect(events.at(-1)).toEqual({ type: 'turn.completed' });
    expect(requests).toHaveLength(3);
    // The original user turn must stay before every tool round. Moving it
    // between rounds breaks pending native web-search calls and their results.
    expect(requests[2].messages.map(message => message.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user',
    ]);
    expect(requests[2].messages.slice(0, 3)).toEqual(requests[1].messages);
    for (const request of requests.slice(1)) {
      request.messages.forEach((message, index) => {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
        const calls = message.content.filter(block => block.type === 'tool_use');
        if (!calls.length) return;
        const results = request.messages[index + 1]?.content;
        expect(results).toEqual(calls.map(call => ({
          type: 'tool_result', tool_use_id: call.id, content: '{"found":true}',
        })));
        expect(message.content[0]).toEqual({ type: 'thinking', thinking: '', signature: 'opaque-signature' });
        expect(calls.map(call => call.input)).toEqual(calls.map(() => ({ q: 'test' })));
      });
    }
    expect(executor.executeToolCalls).toHaveBeenCalledTimes(2);
    const executed = events.filter(event => event.type === 'tool.execution.completed');
    expect(executed.map(event => event.operationId)).toEqual(['toolu_first', 'toolu_parallel', 'toolu_recursive']);
  });
});
