/**
 * Canonical chat runtime reducer tests.
 *
 * These tests buy explicit terminal-state, buffered-stream parity, reasoning,
 * and tool snapshot behavior without any Obsidian mock deciding the result.
 */

import {
  createInitialChatTurnState,
  reduceChatTurn,
} from '../../src/services/llm/runtime/ChatTurnReducer';
import { mapProviderStreamChunk } from '../../src/services/llm/runtime/ProviderStreamEventMapper';
import type { ChatRuntimeEvent } from '../../src/services/llm/runtime/ChatRuntimeEvent';
import type { ToolCall } from '../../src/types/chat/ChatTypes';

function reduceAll(events: ChatRuntimeEvent[]) {
  return events.reduce(reduceChatTurn, createInitialChatTurnState());
}

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'call-1',
    type: 'function',
    function: {
      name: 'content_read',
      arguments: '{}',
    },
    ...overrides,
  };
}

describe('ChatTurnReducer', () => {
  it('reduces incremental and buffered text to equivalent terminal state', () => {
    const incremental = reduceAll([
      ...mapProviderStreamChunk({ content: 'Hel', complete: false }),
      ...mapProviderStreamChunk({ content: 'lo', complete: true }),
      { type: 'turn.completed' },
    ]);
    const buffered = reduceAll([
      ...mapProviderStreamChunk({ content: 'Hello', complete: true }),
      { type: 'turn.completed' },
    ]);

    expect(incremental).toEqual(buffered);
    expect(buffered.phase).toBe('complete');
    expect(buffered.content).toBe('Hello');
  });

  it('keeps reasoning separate from assistant content and marks it complete', () => {
    const state = reduceAll([
      { type: 'reasoning.delta', text: 'Plan', blockId: 'reason-1' },
      { type: 'assistant.delta', text: 'Answer' },
      { type: 'reasoning.completed', blockId: 'reason-1' },
      { type: 'turn.completed' },
    ]);

    expect(state.content).toBe('Answer');
    expect(state.reasoning).toEqual({
      text: 'Plan',
      complete: true,
      blockId: 'reason-1',
      encryptedContent: undefined,
    });
  });

  it('merges progressive tool snapshots by stable ID', () => {
    const state = reduceAll([
      { type: 'tool.snapshot', calls: [toolCall({ function: { name: 'content_read', arguments: '{' } })], ready: false },
      { type: 'tool.snapshot', calls: [toolCall({ function: { name: 'content_read', arguments: '{}' } })], ready: true },
    ]);

    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0].function.arguments).toBe('{}');
    expect(state.phase).toBe('waiting-for-tool');
  });

  it('does not mutate terminal state when late non-terminal events arrive', () => {
    const completed = reduceAll([
      { type: 'assistant.delta', text: 'Done' },
      { type: 'turn.completed' },
    ]);

    expect(reduceChatTurn(completed, { type: 'assistant.delta', text: 'late' }))
      .toBe(completed);
  });

  it('treats an identical terminal event as idempotent', () => {
    const completed = reduceChatTurn(
      createInitialChatTurnState(),
      { type: 'turn.completed', finishReason: 'stop' }
    );

    expect(reduceChatTurn(completed, { type: 'turn.completed', finishReason: 'stop' }))
      .toBe(completed);
  });

  it('rejects a conflicting terminal event', () => {
    const completed = reduceChatTurn(
      createInitialChatTurnState(),
      { type: 'turn.completed' }
    );

    expect(() => reduceChatTurn(completed, {
      type: 'turn.failed',
      error: { message: 'late failure' },
    })).toThrow('Conflicting terminal chat events');
  });

  it('preserves partial content and reasoning on abort', () => {
    const state = reduceAll([
      { type: 'reasoning.delta', text: 'Partial thought' },
      { type: 'assistant.delta', text: 'Partial answer' },
      { type: 'turn.aborted', reason: 'user stopped' },
    ]);

    expect(state.phase).toBe('aborted');
    expect(state.content).toBe('Partial answer');
    expect(state.reasoning.text).toBe('Partial thought');
  });

  it('keeps failure explicit instead of completing an empty turn', () => {
    const state = reduceAll([
      { type: 'turn.failed', error: { message: 'provider stream failed', code: 'STREAM' } },
    ]);

    expect(state.phase).toBe('failed');
    expect(state.error).toEqual({ message: 'provider stream failed', code: 'STREAM' });
    expect(state.content).toBe('');
  });

  it('keeps a provider tool-response boundary non-terminal', () => {
    const events = mapProviderStreamChunk({
      content: '',
      complete: true,
      toolCalls: [toolCall()],
    });
    const state = reduceAll(events);

    expect(events.some(event => event.type === 'turn.completed')).toBe(false);
    expect(state.phase).toBe('waiting-for-tool');
    expect(state.terminalEvent).toBeUndefined();
  });

  it('treats a provider response boundary as non-terminal', () => {
    const waiting = reduceChatTurn(
      reduceChatTurn(createInitialChatTurnState(), {
        type: 'tool.snapshot',
        calls: [toolCall({ function: { name: 'content_read', arguments: '{"path":"note.md"}' } })],
        ready: true,
      }),
      { type: 'response.completed', finishReason: 'tool_calls' }
    );

    expect(waiting.phase).toBe('waiting-for-tool');
    expect(waiting.terminalEvent).toBeUndefined();

    const resumed = reduceChatTurn(waiting, { type: 'assistant.delta', text: 'Done' });
    expect(resumed.content).toBe('Done');
    expect(resumed.terminalEvent).toBeUndefined();
  });

  it('merges zero-valued usage and response metadata without truthy checks', () => {
    const state = reduceAll([
      { type: 'usage.updated', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
      { type: 'response.metadata', metadata: { responseId: 'response-1', zero: 0 } },
      { type: 'response.resolved', provider: 'openai', model: 'gpt-test' },
      { type: 'cost.updated', cost: { totalCost: 0, currency: 'USD' } },
      { type: 'turn.completed' },
    ]);

    expect(state.usage?.totalTokens).toBe(0);
    expect(state.metadata.zero).toBe(0);
    expect(state.provider).toBe('openai');
    expect(state.model).toBe('gpt-test');
    expect(state.cost?.totalCost).toBe(0);
  });
});
