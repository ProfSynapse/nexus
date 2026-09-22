/**
 * GoogleContextBuilder — thought_signature replay.
 *
 * Gemini 3.x rejects (HTTP 400 "Function call is missing a thought_signature")
 * any request that replays a functionCall part without the signature the model
 * attached to it. The adapter and the stored ChatTypes.ToolCall carry the
 * signature as `thought_signature`; the builder used to read only the older
 * `thoughtSignature` spelling, so every tool continuation and every replayed
 * tool turn on the next chat turn dropped it. Found by the live lane in
 * tests/debug/turn-history-live-smoke.test.ts.
 */

import { GoogleContextBuilder } from '../../src/services/chat/builders/GoogleContextBuilder';
import type { GoogleMessage, GooglePart, LLMToolCall, ToolExecutionResult } from '../../src/services/chat/builders/IContextBuilder';
import type { ConversationData } from '../../src/types';

const SIG = 'EsARCr0RAWkUfRNu-signature';

function functionCallParts(messages: GoogleMessage[]): GooglePart[] {
  return messages.flatMap(m => m.parts).filter(p => 'functionCall' in p && p.functionCall);
}

describe('GoogleContextBuilder — thought_signature survives every replay path', () => {
  const builder = new GoogleContextBuilder();
  const result: ToolExecutionResult = { id: 'lookup_secret_0', name: 'lookup_secret', success: true, result: { value: 'x' } };

  it('buildToolContinuation: echoes the adapter-shaped `thought_signature` on the functionCall part', () => {
    const call = {
      id: 'lookup_secret_0',
      type: 'function',
      function: { name: 'lookup_secret', arguments: '{"key":"alpha"}' },
      thought_signature: SIG,
    } as LLMToolCall;

    const messages = builder.buildToolContinuation('Fetch it', [call], [result], []) as GoogleMessage[];
    const [part] = functionCallParts(messages);

    expect(part).toMatchObject({ functionCall: { name: 'lookup_secret', args: { key: 'alpha' } } });
    expect(part.thoughtSignature).toBe(SIG);
  });

  it('buildToolContinuation: still accepts the older `thoughtSignature` spelling', () => {
    const call: LLMToolCall = {
      id: 'lookup_secret_0',
      type: 'function',
      function: { name: 'lookup_secret', arguments: '{}' },
      thoughtSignature: SIG,
    };

    const messages = builder.buildToolContinuation('Fetch it', [call], [result], []) as GoogleMessage[];
    expect(functionCallParts(messages)[0].thoughtSignature).toBe(SIG);
  });

  it('appendToolExecution: echoes the signature on recursive continuations', () => {
    const call = {
      id: 'lookup_secret_0',
      type: 'function',
      function: { name: 'lookup_secret', arguments: '{}' },
      thought_signature: SIG,
    } as LLMToolCall;

    const messages = builder.appendToolExecution([call], [result], [
      { role: 'user', parts: [{ text: 'Fetch it' }] },
    ] as GoogleMessage[]) as GoogleMessage[];
    expect(functionCallParts(messages)[0].thoughtSignature).toBe(SIG);
  });

  it('buildContext: replays the signature stored on a prior turn\'s ToolCall', () => {
    const conversation = {
      id: 'c', title: 't', created: 1, updated: 1,
      messages: [
        { id: 'u1', role: 'user', content: 'Fetch it', timestamp: 1, conversationId: 'c' },
        {
          id: 'a1', role: 'assistant', content: 'done', timestamp: 2, conversationId: 'c',
          toolCalls: [{
            id: 'lookup_secret_0', type: 'function', name: 'lookup_secret', parameters: { key: 'alpha' },
            success: true, result: { value: 'x' }, thought_signature: SIG,
          }],
        },
        { id: 'u2', role: 'user', content: 'What was it?', timestamp: 3, conversationId: 'c' },
      ],
    } as unknown as ConversationData;

    const messages = builder.buildContext(conversation, 'sys') as GoogleMessage[];
    const [part] = functionCallParts(messages);
    expect(part).toMatchObject({ functionCall: { name: 'lookup_secret', args: { key: 'alpha' } } });
    expect(part.thoughtSignature).toBe(SIG);
  });

  it('buildContext: replays stored function responses as a `user` turn, never the legacy `function` role', () => {
    // gemini-3.7-flash and gemini-3.5-flash-lite reject role 'function' with
    // HTTP 400 "Role 'function' is not supported"; 3.1-pro merely tolerates it.
    const conversation = {
      id: 'c', title: 't', created: 1, updated: 1,
      messages: [
        { id: 'u1', role: 'user', content: 'Fetch it', timestamp: 1, conversationId: 'c' },
        {
          id: 'a1', role: 'assistant', content: 'done', timestamp: 2, conversationId: 'c',
          toolCalls: [{ id: 'f_0', type: 'function', name: 'f', parameters: {}, success: true, result: { v: 1 } }],
        },
      ],
    } as unknown as ConversationData;

    const messages = builder.buildContext(conversation, 'sys') as GoogleMessage[];
    const responseTurn = messages.find(m => m.parts.some(p => 'functionResponse' in p));
    expect(responseTurn?.role).toBe('user');
    expect(messages.map(m => m.role)).not.toContain('function');
  });

  it('omits the key entirely when no signature was captured (non-thinking models)', () => {
    const call: LLMToolCall = { id: 'f_0', type: 'function', function: { name: 'f', arguments: '{}' } };
    const messages = builder.buildToolContinuation('go', [call], [{ ...result, id: 'f_0', name: 'f' }], []) as GoogleMessage[];
    expect('thoughtSignature' in functionCallParts(messages)[0]).toBe(false);
  });
});
