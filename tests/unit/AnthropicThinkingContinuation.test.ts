import { AnthropicContextBuilder } from '../../src/services/chat/builders/AnthropicContextBuilder';
import { ProviderMessageBuilder } from '../../src/services/llm/core/ProviderMessageBuilder';
import type { LLMToolCall, ToolExecutionResult } from '../../src/services/chat/builders/IContextBuilder';
import type { ConversationData } from '../../src/types/chat/ChatTypes';

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

  it('replays native search blocks verbatim beside a Nexus tool call', () => {
    const responseContent = [
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', encrypted_content: 'opaque' }] },
      { type: 'text', text: 'Found it.', citations: [{ type: 'web_search_result_location', url: 'https://example.com' }] },
      { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'x' } },
    ];
    const result = new AnthropicContextBuilder().buildToolContinuation('find it', [{
      ...toolCalls[0], anthropic_response_content: responseContent,
    }], toolResults);
    expect(result[1]).toEqual({ role: 'assistant', content: responseContent });
    expect(result[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"found":true}' }] });
  });

  it('rebuilds distinct native search responses in order on the next chat turn', () => {
    const first = [
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', encrypted_content: 'opaque' }] },
      { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'note' } },
    ];
    const final = [{ type: 'text', text: 'Answer', citations: [{ type: 'web_search_result_location', url: 'https://example.com' }] }];
    const conversation = {
      messages: [{
        id: 'msg', role: 'assistant', content: 'Answer', state: 'complete',
        toolCalls: [{ id: 'toolu_1', type: 'function', function: { name: 'read', arguments: '{"path":"note"}' }, result: { found: true }, success: true }],
        metadata: { anthropicResponses: [
          { content: first, toolCallIds: ['toolu_1'], contentEndOffset: 0 },
          { content: final, toolCallIds: [], contentEndOffset: 6 },
        ] },
      }],
    } as ConversationData;
    expect(new AnthropicContextBuilder().buildContext(conversation)).toEqual([
      { role: 'assistant', content: first },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"found":true}' }] },
      { role: 'assistant', content: final },
    ]);
  });
});
