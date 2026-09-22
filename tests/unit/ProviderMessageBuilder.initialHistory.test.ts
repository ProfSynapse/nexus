/**
 * Turn-by-turn history on the initial request of every chat turn.
 *
 * Before this change `ProviderMessageBuilder.buildInitialOptions` rendered
 * every prior turn as a `=== Conversation History ===` text transcript inside
 * the system prompt and sent only the latest user message as a real turn —
 * for every provider except Google. On the way there
 * `StreamingResponseService.buildLLMMessages` projected each message to
 * `{ role, content: string }`, which emptied every Anthropic tool turn.
 *
 * These tests run the real pipeline from a stored conversation with a prior
 * tool round to the `generateOptions` handed to the adapter and assert, per
 * provider, that the tool turn arrives structurally and that the system
 * prompt carries no transcript. The CLI transports are the one sanctioned
 * exception and are pinned as such.
 *
 * See docs/plans/turn-by-turn-history-and-provider-costing-plan.md.
 */

import type { ConversationData } from '../../src/types';
import {
  ProviderMessageBuilder,
  TEXT_HISTORY_PROVIDERS,
  type ConversationMessage,
  type GoogleMessage,
} from '../../src/services/llm/core/ProviderMessageBuilder';
import { StreamingResponseService, type StreamingDependencies } from '../../src/services/chat/StreamingResponseService';
import type { LLMContentBlock } from '../../src/services/chat/builders/IContextBuilder';

const SYSTEM = 'You are a careful assistant.';
const TRANSCRIPT_MARKER = '=== Conversation History ===';

function makeConversation(): ConversationData {
  return {
    id: 'conv-history',
    title: 'History test',
    created: Date.now(),
    updated: Date.now(),
    messages: [
      { id: 'm1', role: 'user', content: 'What is the weather in Paris?', timestamp: 1, conversationId: 'conv-history' },
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        timestamp: 2,
        conversationId: 'conv-history',
        toolCalls: [
          {
            id: 'call_abc123',
            type: 'function' as const,
            name: 'get_weather',
            parameters: { city: 'Paris' },
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            success: true,
            result: { temp: 20, condition: 'cloudy' },
          },
        ],
      },
      { id: 'm3', role: 'assistant', content: 'Paris is 20C and cloudy.', timestamp: 3, conversationId: 'conv-history' },
      { id: 'm4', role: 'user', content: 'Now check Tokyo.', timestamp: 4, conversationId: 'conv-history' },
    ],
  } as unknown as ConversationData;
}

function makeService(): StreamingResponseService {
  const deps: StreamingDependencies = {
    llmService: {
      getDefaultModel: jest.fn(() => ({ provider: 'openrouter', model: 'test-model' })),
      // eslint-disable-next-line require-yield
      generateResponseStream: async function* () { throw new Error('not stubbed'); },
    },
    conversationService: {
      getConversation: jest.fn(async () => null),
      addMessage: jest.fn(async () => undefined),
      updateConversation: jest.fn(async () => undefined),
    },
    toolCallService: {} as unknown as StreamingDependencies['toolCallService'],
    costTrackingService: {} as unknown as StreamingDependencies['costTrackingService'],
  };
  return new StreamingResponseService(deps);
}

/** Run the real pre-network pipeline for one provider. */
function buildFor(provider: string) {
  const svc = makeService();
  const messages = (svc as unknown as {
    buildLLMMessages: (c: ConversationData, p: string, s?: string) => ConversationMessage[];
  }).buildLLMMessages(makeConversation(), provider, SYSTEM);

  const builder = new ProviderMessageBuilder(new Map());
  return { messages, ...builder.buildInitialOptions(provider, 'test-model', messages) };
}

describe('buildInitialOptions — history travels as turns, not as system-prompt prose', () => {
  it('anthropic: tool_use / tool_result content blocks survive and the last user message is a turn', () => {
    const { generateOptions, userPrompt } = buildFor('anthropic');

    expect(generateOptions.systemPrompt).toBe(SYSTEM);
    expect(generateOptions.systemPrompt).not.toContain(TRANSCRIPT_MARKER);
    expect(userPrompt).toBe('Now check Tokyo.');

    const history = generateOptions.conversationHistory as ConversationMessage[];
    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);

    const toolUse = (history[1].content as LLMContentBlock[]).find(b => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ id: 'call_abc123', name: 'get_weather', input: { city: 'Paris' } });

    const toolResult = (history[2].content as LLMContentBlock[]).find(b => b.type === 'tool_result');
    expect(toolResult).toMatchObject({ tool_use_id: 'call_abc123' });
    expect(toolResult?.content).toContain('cloudy');

    expect(history[4]).toEqual({ role: 'user', content: 'Now check Tokyo.' });
  });

  it('openrouter (chat completions): tool_calls and role:tool survive with matching ids', () => {
    const { generateOptions } = buildFor('openrouter');

    expect(generateOptions.systemPrompt).toBe(SYSTEM);
    const history = generateOptions.conversationHistory as ConversationMessage[];
    expect(history.some(m => m.role === 'system')).toBe(false);

    const assistantToolTurn = history.find(m => m.role === 'assistant' && m.tool_calls?.length);
    expect(assistantToolTurn?.tool_calls?.[0]).toMatchObject({
      id: 'call_abc123',
      function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
    });

    const toolTurn = history.find(m => m.role === 'tool');
    expect(toolTurn).toMatchObject({ tool_call_id: 'call_abc123' });
    expect(history[history.length - 1]).toMatchObject({ role: 'user', content: 'Now check Tokyo.' });
  });

  it('google: functionCall / functionResponse parts survive', () => {
    const { generateOptions } = buildFor('google');

    expect(generateOptions.systemPrompt).toBe(SYSTEM);
    const history = generateOptions.conversationHistory as GoogleMessage[];
    expect(history.every(m => Array.isArray(m.parts))).toBe(true);

    const call = history.flatMap(m => m.parts).find(p => 'functionCall' in p && p.functionCall);
    expect(call).toMatchObject({ functionCall: { name: 'get_weather' } });

    const response = history.flatMap(m => m.parts).find(p => 'functionResponse' in p && p.functionResponse);
    expect(response).toMatchObject({ functionResponse: { name: 'get_weather' } });

    expect(history[history.length - 1]).toEqual({ role: 'user', parts: [{ text: 'Now check Tokyo.' }] });
  });

  it.each(['openai', 'openai-codex'])('%s (Responses API): function_call and function_call_output items with the prompt last', (provider) => {
    const { generateOptions } = buildFor(provider);

    expect(generateOptions.systemPrompt).toBe(SYSTEM);
    const items = generateOptions.conversationHistory as Array<Record<string, unknown>>;

    const call = items.find(i => i.type === 'function_call');
    expect(call).toMatchObject({ call_id: 'call_abc123', name: 'get_weather', arguments: '{"city":"Paris"}' });

    const output = items.find(i => i.type === 'function_call_output');
    expect(output).toMatchObject({ call_id: 'call_abc123' });
    expect(String(output?.output)).toContain('cloudy');

    expect(items[items.length - 1]).toEqual({ role: 'user', content: 'Now check Tokyo.' });
    expect(items.some(i => i.role === 'system')).toBe(false);
  });

  it.each([...TEXT_HISTORY_PROVIDERS])('%s (CLI transport): keeps the text transcript in the system prompt', (provider) => {
    const { generateOptions, userPrompt } = buildFor(provider);

    expect(generateOptions.conversationHistory).toBeUndefined();
    expect(generateOptions.systemPrompt).toContain(SYSTEM);
    expect(generateOptions.systemPrompt).toContain(TRANSCRIPT_MARKER);
    expect(generateOptions.systemPrompt).toContain('User: What is the weather in Paris?');
    expect(userPrompt).toBe('Now check Tokyo.');
  });

  it('lifts a system message out of the messages array without flattening the rest', () => {
    const builder = new ProviderMessageBuilder(new Map());
    const messages: ConversationMessage[] = [
      { role: 'system', content: 'from-branch' },
      { role: 'user', content: 'hi' },
    ];
    const { generateOptions } = builder.buildInitialOptions('anthropic', 'm', messages, { systemPrompt: 'from-options' });

    expect(generateOptions.systemPrompt).toBe('from-options\n\nfrom-branch');
    expect(generateOptions.conversationHistory).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('buildLLMMessages — returns the builder output unchanged', () => {
  it('does not project Anthropic content-block arrays to empty strings', () => {
    const { messages } = buildFor('anthropic');
    const toolTurn = messages.find(m => m.role === 'assistant' && Array.isArray(m.content));
    expect(toolTurn).toBeDefined();
    expect((toolTurn?.content as LLMContentBlock[]).some(b => b.type === 'tool_use')).toBe(true);
  });

  it('gives Google the same builder as every other provider (tool turns included)', () => {
    const { messages } = buildFor('google');
    const withParts = messages as unknown as GoogleMessage[];
    expect(withParts.some(m => m.parts?.some(p => 'functionCall' in p))).toBe(true);
  });
});
