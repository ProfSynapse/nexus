/**
 * Reproduction test for Azure "Missing required parameter: 'input[N].call_id'" error.
 *
 * Root cause: StreamingResponseService.buildLLMMessages was mapping every
 * message to {role, content} only, stripping tool_calls and tool_call_id.
 * When a stored conversation had tool calls, the continuation request to
 * OpenRouter (forwarded to Azure for OpenAI models) had tool messages with
 * NO tool_call_id, causing Azure to reject with the call_id error.
 */

import { __setRequestUrlMock } from 'obsidian';
import { ConversationContextBuilder } from '../../src/services/chat/ConversationContextBuilder';
import type { ConversationData } from '../../src/types';

beforeAll(() => {
  __setRequestUrlMock(async () => ({
    status: 200,
    headers: {},
    text: '',
    json: {},
    arrayBuffer: new ArrayBuffer(0),
  }));
});

/**
 * Simulate buildLLMMessages BEFORE the fix — strips tool_calls/tool_call_id.
 */
function buildLLMMessagesBuggy(conversation: ConversationData): Array<{ role: string; content: string }> {
  return ConversationContextBuilder.buildContextForProvider(
    conversation,
    'openrouter',
    'system prompt'
  ).map((message) => ({
    role: message.role,
    content: 'content' in message && typeof message.content === 'string' ? message.content : ''
  }));
}

/**
 * Simulate buildLLMMessages AFTER the fix — preserves tool_calls/tool_call_id.
 */
function buildLLMMessagesFixed(conversation: ConversationData): Array<Record<string, unknown>> {
  return ConversationContextBuilder.buildContextForProvider(
    conversation,
    'openrouter',
    'system prompt'
  ).map((message) => {
    const m = message as {
      role: string;
      content?: unknown;
      tool_calls?: unknown;
      tool_call_id?: string;
    };
    const out: Record<string, unknown> = {
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
    };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });
}

describe('Azure call_id bug reproduction', () => {
  // Build a conversation with prior tool call rounds (mimics user's scenario)
  const conversationWithToolCalls: ConversationData = {
    id: 'test-conv',
    title: 'Test',
    created: Date.now(),
    updated: Date.now(),
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'What is the weather in Paris?',
        timestamp: Date.now(),
        conversationId: 'test-conv',
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        conversationId: 'test-conv',
        toolCalls: [
          {
            id: 'call_abc123',
            type: 'function' as const,
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            success: true,
            result: { temp: 20, condition: 'cloudy' },
          },
        ],
      },
      {
        id: 'm3',
        role: 'assistant',
        content: 'Paris is 20C and cloudy.',
        timestamp: Date.now(),
        conversationId: 'test-conv',
      },
      {
        id: 'm4',
        role: 'user',
        content: 'Now check Tokyo.',
        timestamp: Date.now(),
        conversationId: 'test-conv',
      },
    ],
  } as unknown as ConversationData;

  it('BUGGY version strips tool_call_id (reproduces Azure error)', () => {
    const messages = buildLLMMessagesBuggy(conversationWithToolCalls);

    // Find the tool result message (built from the toolCall entry on m2)
    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);

    // Bug: tool message has no tool_call_id
    for (const tm of toolMessages) {
      expect((tm as Record<string, unknown>).tool_call_id).toBeUndefined();
    }

    // Bug: assistant tool_calls is also stripped
    const assistantWithCalls = messages.filter(
      (m) => m.role === 'assistant' && (m as Record<string, unknown>).tool_calls
    );
    expect(assistantWithCalls.length).toBe(0); // tool_calls stripped!
  });

  it('FIXED version preserves tool_call_id and tool_calls', () => {
    const messages = buildLLMMessagesFixed(conversationWithToolCalls);

    // Tool message has tool_call_id
    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);
    for (const tm of toolMessages) {
      expect(tm.tool_call_id).toBeTruthy();
      expect(tm.tool_call_id).toBe('call_abc123');
    }

    // Assistant message preserves tool_calls
    const assistantWithCalls = messages.filter(
      (m) => m.role === 'assistant' && m.tool_calls
    );
    expect(assistantWithCalls.length).toBe(1);
    const calls = (assistantWithCalls[0].tool_calls as Array<{ id: string }>);
    expect(calls[0].id).toBe('call_abc123');

    // CRITICAL: assistant tool_calls[i].id must match tool message tool_call_id
    expect(calls[0].id).toBe(toolMessages[0].tool_call_id);
  });
});
