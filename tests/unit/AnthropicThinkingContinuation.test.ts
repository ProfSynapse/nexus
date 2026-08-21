import { AnthropicContextBuilder } from '../../src/services/chat/builders/AnthropicContextBuilder';
import { ProviderMessageBuilder } from '../../src/services/llm/core/ProviderMessageBuilder';
import type { LLMToolCall, ToolExecutionResult } from '../../src/services/chat/builders/IContextBuilder';

describe('Anthropic thinking continuation', () => {
  const thinkingBlocks = [
    { type: 'thinking' as const, thinking: 'summary', signature: 'sig_opaque' },
    { type: 'redacted_thinking' as const, data: 'redacted_opaque' }
  ];

  const toolCalls: LLMToolCall[] = [{
    id: 'toolu_1',
    type: 'function',
    function: { name: 'search', arguments: '{"q":"x"}' },
    anthropic_thinking_blocks: thinkingBlocks
  }];

  const toolResults: ToolExecutionResult[] = [{
    id: 'toolu_1',
    success: true,
    result: { found: true }
  }];

  it('replays opaque blocks unchanged and before tool_use', () => {
    const messages = new AnthropicContextBuilder().buildToolContinuation(
      'find it',
      toolCalls,
      toolResults
    );

    expect(messages).toEqual([
      { role: 'user', content: 'find it' },
      {
        role: 'assistant',
        content: [
          ...thinkingBlocks,
          { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'x' } }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"found":true}' }]
      }
    ]);
  });

  it('keeps thinking enabled when building the continuation request', () => {
    const options = new ProviderMessageBuilder(new Map()).buildContinuationOptions(
      'anthropic',
      'find it',
      toolCalls,
      toolResults,
      [],
      {
        model: 'claude-sonnet-5',
        enableThinking: true,
        thinkingEffort: 'high'
      }
    );

    expect(options.enableThinking).toBe(true);
    expect(options.conversationHistory?.[1]).toEqual({
      role: 'assistant',
      content: [
        ...thinkingBlocks,
        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'x' } }
      ]
    });
  });
});
