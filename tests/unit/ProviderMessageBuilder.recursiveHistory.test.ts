import { ConversationContextBuilder } from '../../src/services/chat/ConversationContextBuilder';
import { ProviderMessageBuilder, type ConversationMessage } from '../../src/services/llm/core/ProviderMessageBuilder';
import type { BaseAdapter } from '../../src/services/llm/adapters/BaseAdapter';
import type { GenerateOptions } from '../../src/services/llm/adapters/types';
import type { IAdapterRegistry } from '../../src/services/llm/core/AdapterRegistry';
import { StreamingOrchestrator } from '../../src/services/llm/core/StreamingOrchestrator';

// No context-builder mocks: the legacy previousMessages accumulator deliberately
// excludes the latest user prompt, while the actual request history includes it.
const providers = [
  ['openrouter', 'google/gemini-test'], ['groq', 'test'], ['mistral', 'mistral-large-4'],
  ['requesty', 'mistral/mistral-large-4'], ['deepseek', 'test'], ['perplexity', 'test'],
  ['github-copilot', 'test'], ['lmstudio', 'test'], ['ollama', 'test'],
  ['lmstudio', 'nexus-test'], ['ollama', 'nexus-test'], ['webllm', 'nexus-test'],
  ['google', 'gemini-test'], ['openai-codex', 'test'],
];

describe.each(providers)('%s (%s) recursive request history', (provider, model) => {
  it('keeps the original user turn and both tool rounds in order without mutating earlier requests', () => {
    const builder = new ProviderMessageBuilder(new Map());
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'Look up both items' },
    ];
    const first = builder.buildInitialOptions(provider, model, messages);
    const calls = [1, 2].map(round => [{
      id: `provider-call-${round}`, type: 'function' as const,
      function: { name: 'lookup', arguments: JSON.stringify({ round }) },
      thought_signature: `signature-${round}`,
      reasoning_details: [{ type: 'reasoning.encrypted', data: `opaque-${round}` }],
      mistral_assistant_content: [{ type: 'thinking', thinking: [{ type: 'text', text: `reason-${round}` }] }],
    }]);
    const results = calls.map(round => round.map(call => ({
      id: call.id, name: 'lookup', success: true, result: { found: call.id },
    })));
    const previous = messages.slice(0, -1);
    const second = builder.buildContinuationOptions(provider, first.userPrompt, calls[0], results[0], previous, first.generateOptions);
    const secondSnapshot: unknown = JSON.parse(JSON.stringify(second.conversationHistory));
    const accumulatedPrevious = ConversationContextBuilder.appendToolExecution(
      provider, calls[0], results[0], previous, model,
    ) as ConversationMessage[];
    const third = builder.buildContinuationOptions(provider, first.userPrompt, calls[1], results[1], accumulatedPrevious, second);
    const history = third.conversationHistory as Array<Record<string, unknown>>;

    expect(history.slice(0, second.conversationHistory?.length)).toEqual(secondSnapshot);
    expect(second.conversationHistory).toEqual(secondSnapshot);
    expect(history.slice(0, 3)).toEqual(first.generateOptions.conversationHistory);
    expect(JSON.stringify(history).match(/Look up both items/g)).toHaveLength(1);

    if (provider === 'google') {
      expect(history.map(message => message.role)).toEqual(['user', 'model', 'user', 'model', 'user', 'model', 'user']);
      expect(history[3]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'lookup', args: { round: 1 } }, thoughtSignature: 'signature-1' }] });
      expect(history[5]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'lookup', args: { round: 2 } }, thoughtSignature: 'signature-2' }] });
    } else if (provider === 'openai-codex') {
      expect(history.slice(3).map(item => [item.type, item.call_id])).toEqual([
        ['function_call', 'provider-call-1'], ['function_call_output', 'provider-call-1'],
        ['function_call', 'provider-call-2'], ['function_call_output', 'provider-call-2'],
      ]);
    } else if (!model.startsWith('nexus')) {
      expect(history.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'tool', 'assistant', 'tool']);
      expect(history[4].tool_call_id).toBe('provider-call-1');
      expect(history[6].tool_call_id).toBe('provider-call-2');
      expect(history[3].reasoning_details).toEqual(calls[0][0].reasoning_details);
      if (provider === 'mistral' || provider === 'requesty') {
        expect(history[3].content).toEqual(calls[0][0].mistral_assistant_content);
      }
    }
  });
});

it('keeps flattened stored Codex tool pairs in the first and recursive continuations', () => {
  const builder = new ProviderMessageBuilder(new Map());
  const messages: ConversationMessage[] = [
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'stored-id', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'stored-id', content: '{"found":true}' },
    { role: 'user', content: 'Follow up' },
  ];
  const initial = builder.buildInitialOptions('openai-codex', 'test', messages);
  const continuation = builder.buildContinuationOptions('openai-codex', initial.userPrompt, [], [], messages.slice(0, -1), initial.generateOptions);
  expect(continuation.conversationHistory).toEqual(initial.generateOptions.conversationHistory);
  expect(continuation.conversationHistory).toEqual([
    { role: 'user', content: 'Earlier question' },
    { type: 'function_call', call_id: 'stored-id', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'stored-id', output: '{"found":true}' },
    { role: 'user', content: 'Follow up' },
  ]);
});

it.each(['google', 'openrouter'])('%s preserves request prefixes through actual recursive orchestration', async provider => {
  const requests: Array<Array<Record<string, unknown>>> = [];
  // Only the provider response is a fixture. Real orchestration and real
  // context builders decide the outgoing history recorded here.
  const adapter = {
    async *generateStreamAsync(_prompt: string, options: GenerateOptions) {
      requests.push(JSON.parse(JSON.stringify(options.conversationHistory)));
      const round = requests.length;
      yield round < 3
        ? { content: '', complete: true, toolCallsReady: true, toolCalls: [{
          id: `call-${round}`, type: 'function',
          function: { name: 'lookup', arguments: JSON.stringify({ round }) },
          thought_signature: `signature-${round}`,
        }] }
        : { content: 'Done', complete: true };
    },
  } as unknown as BaseAdapter;
  const registry: IAdapterRegistry = {
    initialize: jest.fn(), updateSettings: jest.fn(), clear: jest.fn(),
    getAdapter: () => adapter, getAvailableProviders: () => [provider], isProviderAvailable: () => true,
  };
  const orchestrator = new StreamingOrchestrator(registry, {
    providers: {}, defaultModel: { provider, model: 'test-model' },
  }, {
    executeToolCalls: async calls => calls.map(call => ({ id: call.id, name: 'lookup', success: true, result: { found: true } })),
  });
  const events = [];
  for await (const event of orchestrator.generateResponseStream([{ role: 'user', content: 'Look up both items' }], {
    tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up', parameters: { type: 'object' } } }],
  })) events.push(event);
  expect(events[events.length - 1]).toEqual({ type: 'turn.completed' });
  expect(requests).toHaveLength(3);
  expect(requests[1].slice(0, requests[0].length)).toEqual(requests[0]);
  expect(requests[2].slice(0, requests[1].length)).toEqual(requests[1]);
  expect(JSON.stringify(requests[2]).match(/Look up both items/g)).toHaveLength(1);
  if (provider === 'google') {
    expect(requests[2][1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'lookup', args: { round: 1 } }, thoughtSignature: 'signature-1' }] });
    expect(requests[2][3]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'lookup', args: { round: 2 } }, thoughtSignature: 'signature-2' }] });
  }
});
