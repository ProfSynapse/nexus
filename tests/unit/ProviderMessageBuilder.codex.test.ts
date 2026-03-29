/**
 * ProviderMessageBuilder — openai-codex continuation branch tests
 *
 * Tests the stateless Responses API input array construction used by the
 * Codex provider in buildContinuationOptions.
 */

import {
  ProviderMessageBuilder,
  ConversationMessage,
  GenerateOptionsInternal,
} from '../../src/services/llm/core/ProviderMessageBuilder';

// Mock ConversationContextBuilder — not needed for the openai-codex branch
// (it builds its own input array without calling ConversationContextBuilder)
jest.mock('../../src/services/chat/ConversationContextBuilder', () => ({
  ConversationContextBuilder: {
    buildToolContinuation: jest.fn(),
    buildResponsesAPIToolInput: jest.fn(),
  },
}));

describe('ProviderMessageBuilder — openai-codex continuation', () => {
  let builder: ProviderMessageBuilder;
  const baseGenerateOptions: GenerateOptionsInternal = {
    model: 'gpt-5.3-codex',
    systemPrompt: 'You are helpful.',
    tools: [{ type: 'function', name: 'getTools', parameters: {} } as any],
  };

  beforeEach(() => {
    builder = new ProviderMessageBuilder(new Map());
  });

  it('should build a full input array with prior messages, user prompt, function_call, and function_call_output', () => {
    const previousMessages: ConversationMessage[] = [
      { role: 'user', content: 'Hi there' },
      { role: 'assistant', content: 'Hello!' },
    ];

    const toolCalls = [
      {
        id: 'call_abc',
        type: 'function' as const,
        function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
      },
    ];

    const toolResults = [
      { id: 'call_abc', name: 'get_weather', success: true, result: { temp: 72 } },
    ];

    const result = builder.buildContinuationOptions(
      'openai-codex',
      'What is the weather?',
      toolCalls,
      toolResults,
      previousMessages,
      baseGenerateOptions,
    );

    const input = result.conversationHistory as Array<Record<string, unknown>>;

    // Prior messages included (non-system)
    expect(input[0]).toEqual({ role: 'user', content: 'Hi there' });
    expect(input[1]).toEqual({ role: 'assistant', content: 'Hello!' });

    // Current user prompt
    expect(input[2]).toEqual({ role: 'user', content: 'What is the weather?' });

    // function_call item
    expect(input[3]).toEqual({
      type: 'function_call',
      call_id: 'call_abc',
      name: 'get_weather',
      arguments: '{"city":"NYC"}',
    });

    // function_call_output item
    expect(input[4]).toEqual({
      type: 'function_call_output',
      call_id: 'call_abc',
      output: JSON.stringify({ temp: 72 }),
    });
  });

  it('should skip system messages from previous messages', () => {
    const previousMessages: ConversationMessage[] = [
      { role: 'system', content: 'System prompt in messages' },
      { role: 'user', content: 'Hello' },
    ];

    const result = builder.buildContinuationOptions(
      'openai-codex',
      'Follow up',
      [],
      [],
      previousMessages,
      baseGenerateOptions,
    );

    const input = result.conversationHistory as Array<Record<string, unknown>>;

    // System message should be skipped
    expect(input[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(input[1]).toEqual({ role: 'user', content: 'Follow up' });
    expect(input).toHaveLength(2);
  });

  it('should not include previousResponseId in output', () => {
    const result = builder.buildContinuationOptions(
      'openai-codex',
      'test',
      [],
      [],
      [],
      baseGenerateOptions,
      { conversationId: 'conv-1', responsesApiId: 'resp-old' } as any,
    );

    expect(result.previousResponseId).toBeUndefined();
  });

  it('should preserve systemPrompt and tools from generateOptions', () => {
    const result = builder.buildContinuationOptions(
      'openai-codex',
      'test',
      [],
      [],
      [],
      baseGenerateOptions,
    );

    expect(result.systemPrompt).toBe('You are helpful.');
    expect(result.tools).toEqual(baseGenerateOptions.tools);
  });

  it('should handle multiple tool calls and results', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
      },
      {
        id: 'call_2',
        type: 'function' as const,
        function: { name: 'get_time', arguments: '{"tz":"EST"}' },
      },
    ];

    const toolResults = [
      { id: 'call_1', success: true, result: { temp: 72 } },
      { id: 'call_2', success: true, result: { time: '3:00 PM' } },
    ];

    const result = builder.buildContinuationOptions(
      'openai-codex',
      'weather and time',
      toolCalls,
      toolResults,
      [],
      baseGenerateOptions,
    );

    const input = result.conversationHistory as Array<Record<string, unknown>>;

    // user prompt + 2 function_call + 2 function_call_output = 5 items
    expect(input).toHaveLength(5);

    expect(input[1]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'get_weather' });
    expect(input[2]).toMatchObject({ type: 'function_call', call_id: 'call_2', name: 'get_time' });
    expect(input[3]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    expect(input[4]).toMatchObject({ type: 'function_call_output', call_id: 'call_2' });
  });

  it('should format failed tool results with error JSON', () => {
    const toolCalls = [
      {
        id: 'call_fail',
        type: 'function' as const,
        function: { name: 'broken_tool', arguments: '{}' },
      },
    ];

    const toolResults = [
      { id: 'call_fail', success: false, error: 'Tool timed out' },
    ];

    const result = builder.buildContinuationOptions(
      'openai-codex',
      'try this',
      toolCalls,
      toolResults,
      [],
      baseGenerateOptions,
    );

    const input = result.conversationHistory as Array<Record<string, unknown>>;
    const output = input.find(i => i.type === 'function_call_output');

    expect(output).toBeDefined();
    expect(JSON.parse(output!.output as string)).toEqual({ error: 'Tool timed out' });
  });

  it('should extract name from ChatToolCall union type (name property)', () => {
    // ChatToolCall has a top-level `name` property in addition to function.name
    const toolCalls = [
      {
        id: 'call_chat',
        type: 'function' as const,
        name: 'chat_tool_name',
        function: { name: 'function_name', arguments: '{}' },
      },
    ];

    const toolResults = [
      { id: 'call_chat', success: true, result: {} },
    ];

    const result = builder.buildContinuationOptions(
      'openai-codex',
      'test',
      toolCalls,
      toolResults,
      [],
      baseGenerateOptions,
    );

    const input = result.conversationHistory as Array<Record<string, unknown>>;
    const fnCall = input.find(i => i.type === 'function_call');

    // Should prefer the top-level name (ChatToolCall path)
    expect(fnCall!.name).toBe('chat_tool_name');
  });

  it('should omit user prompt from input when empty', () => {
    const result = builder.buildContinuationOptions(
      'openai-codex',
      '', // empty prompt (continuation without new user message)
      [],
      [],
      [{ role: 'user', content: 'earlier' }],
      baseGenerateOptions,
    );

    const input = result.conversationHistory as Array<Record<string, unknown>>;

    // Only the prior message, no empty user prompt added
    expect(input).toHaveLength(1);
    expect(input[0]).toEqual({ role: 'user', content: 'earlier' });
  });
});
