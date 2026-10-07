import { createParser } from 'eventsource-parser';
import { LLMProviderError, type StreamChunk, type ToolCall } from '../types';
import { extractStreamErrorMessage } from '../../streaming/streamErrorFrames';
import { TokenUsageExtractor } from '../../utils/TokenUsageExtractor';
import { synthesizeToolCallId } from '../../utils/toolCallId';
import { mapOpenAiCompatFinishReason } from '../shared/OpenAICompatHelpers';

type RecordValue = Record<string, unknown>;
export function asRecord(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : undefined;
}
function protocolError(message: string, provider: string): LLMProviderError {
  return new LLMProviderError(message, provider, 'PROTOCOL_ERROR');
}
function checkToolCalls(calls: ToolCall[], provider: string): ToolCall[] {
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call.function.name || !call.id || ids.has(call.id)) {
      throw protocolError('Endpoint returned an incomplete or duplicate function call.', provider);
    }
    ids.add(call.id);
    let args: unknown;
    try { args = JSON.parse(call.function.arguments); }
    catch { throw protocolError('Endpoint returned malformed function arguments.', provider); }
    if (!asRecord(args)) throw protocolError('Function arguments must be a JSON object.', provider);
  }
  return calls;
}
function reasoningOf(message: RecordValue): string | undefined {
  const value = message.reasoning ?? message.reasoning_content;
  return typeof value === 'string' && value.length ? value : undefined;
}
function preserveReasoning(call: ToolCall, value: RecordValue): void {
  if (Array.isArray(value.reasoning_details)) {
    call.reasoning_details = value.reasoning_details.filter(entry => !!asRecord(entry)) as RecordValue[];
  }
  if (typeof value.thought_signature === 'string') call.thought_signature = value.thought_signature;
}

export interface OpenAICompatibleCompletion {
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  finishReason: ReturnType<typeof mapOpenAiCompatFinishReason>;
  usage: ReturnType<typeof TokenUsageExtractor.normalize>;
}

export function normalizeOpenAICompatibleCompletion(value: unknown, provider: string): OpenAICompatibleCompletion {
  const error = extractStreamErrorMessage(value);
  if (error) throw new LLMProviderError(error, provider, 'PROVIDER_STREAM_ERROR');
  const response = asRecord(value);
  const choice = asRecord(Array.isArray(response?.choices) ? response.choices[0] : undefined);
  const message = asRecord(choice?.message);
  if (!message) throw protocolError('Endpoint returned no assistant message.', provider);
  const content = typeof message.content === 'string' ? message.content
    : typeof message.refusal === 'string' ? message.refusal : '';
  const toolCalls: ToolCall[] = [];
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
    throw protocolError('Endpoint returned an invalid tool_calls array.', provider);
  }
  for (const raw of (message.tool_calls as unknown[] | undefined) ?? []) {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    if (!call || call.type !== 'function' || !fn
      || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
      throw protocolError('Endpoint returned an invalid function call.', provider);
    }
    const normalized: ToolCall = {
      id: typeof call.id === 'string' && call.id ? call.id : synthesizeToolCallId(),
      type: 'function', function: { name: fn.name, arguments: fn.arguments },
    };
    preserveReasoning(normalized, message);
    preserveReasoning(normalized, call);
    toolCalls.push(normalized);
  }
  checkToolCalls(toolCalls, provider);
  if (!content.trim() && !toolCalls.length) throw protocolError('Endpoint returned an empty response.', provider);
  return {
    content, reasoning: reasoningOf(message), toolCalls,
    finishReason: mapOpenAiCompatFinishReason(typeof choice?.finish_reason === 'string' ? choice.finish_reason : null),
    usage: TokenUsageExtractor.normalize(response?.usage),
  };
}

/** One response body, including servers which answer stream:true with ordinary JSON. */
export async function* processOpenAICompatibleStream(
  body: AsyncIterable<string | Uint8Array>, provider: string,
): AsyncGenerator<StreamChunk, void, unknown> {
  const decoder = new TextDecoder();
  const queue: StreamChunk[] = [];
  const calls = new Map<number, ToolCall>();
  const state: { mode: 'unknown' | 'json' | 'sse' } = { mode: 'unknown' };
  let pending = '';
  let done = false;
  let finishReason: string | undefined;
  let output = '';
  let emittedReasoning = false;
  let usage: StreamChunk['usage'];
  let failure: Error | undefined;
  const parser = createParser(event => {
    if (event.type !== 'event' || failure) return;
    // Provider-owned progress/approval events are informational, never Nexus calls.
    if (event.event && event.event !== 'message' && event.event !== 'error') return;
    if (event.data.trim() === '[DONE]') { done = true; return; }
    if (done) return;
    try {
      const frame: unknown = JSON.parse(event.data);
      const error = extractStreamErrorMessage(frame)
        ?? (event.event === 'error' ? 'Endpoint reported a streaming error.' : null);
      if (error) throw new LLMProviderError(error, provider, 'PROVIDER_STREAM_ERROR');
      const parsed = asRecord(frame);
      if (!parsed || !Array.isArray(parsed.choices)) throw protocolError('Malformed completion stream frame.', provider);
      usage = TokenUsageExtractor.normalize(parsed.usage) ?? usage;
      const choice = asRecord(parsed.choices[0]);
      if (!choice) return; // The trailing usage-only frame has choices: [].
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
      const delta = asRecord(choice.delta);
      if (!delta) throw protocolError('Stream frame is missing its delta.', provider);
      if (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') {
        throw protocolError('Stream content must be text.', provider);
      }
      const text = typeof delta.content === 'string' ? delta.content
        : typeof delta.refusal === 'string' ? delta.refusal : '';
      if (text) { output += text; queue.push({ content: text, complete: false }); }
      const reasoning = reasoningOf(delta);
      if (reasoning) {
        emittedReasoning = true;
        queue.push({ content: '', complete: false, reasoning, reasoningComplete: false });
      }
      if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) {
        throw protocolError('Stream tool_calls must be an array.', provider);
      }
      for (const raw of (delta.tool_calls as unknown[] | undefined) ?? []) {
        const fragment = asRecord(raw);
        const index = fragment?.index;
        if (!fragment || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
          throw protocolError('Stream function call is missing a valid index.', provider);
        }
        if (fragment.type !== undefined && fragment.type !== 'function') {
          throw protocolError('Unsupported streamed tool type.', provider);
        }
        const existing = calls.get(index) ?? {
          id: synthesizeToolCallId(), type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        const fn = asRecord(fragment.function);
        if (typeof fragment.id === 'string' && fragment.id) existing.id = fragment.id;
        if (typeof fn?.name === 'string') existing.function.name += fn.name;
        if (typeof fn?.arguments === 'string') existing.function.arguments += fn.arguments;
        preserveReasoning(existing, delta);
        preserveReasoning(existing, fragment);
        calls.set(index, existing);
      }
    } catch (error) {
      failure = error instanceof LLMProviderError ? error : protocolError('Malformed JSON in completion stream.', provider);
    }
  });
  function feed(text: string): void {
    if (state.mode === 'unknown') {
      pending += text;
      const start = pending.trimStart();
      if (!start) return;
      state.mode = start.startsWith('{') || start.startsWith('[') ? 'json' : 'sse';
      if (state.mode === 'sse') { parser.feed(pending); pending = ''; }
    } else if (state.mode === 'json') pending += text;
    else parser.feed(text);
  }
  for await (const bytes of body) {
    feed(typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true }));
    while (queue.length) yield queue.shift()!;
    if (failure) throw failure;
    // DONE is terminal even when the server keeps its HTTP connection open.
    // Breaking also releases the body's iterator (and the desktop socket).
    if (done) break;
  }
  feed(decoder.decode());
  while (queue.length) yield queue.shift()!;
  if (failure) throw failure;
  if (state.mode === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(pending); }
    catch { throw protocolError('Endpoint returned malformed JSON.', provider); }
    const completion = normalizeOpenAICompatibleCompletion(parsed, provider);
    if (completion.reasoning) yield { content: '', complete: false, reasoning: completion.reasoning, reasoningComplete: true };
    yield {
      content: completion.content, complete: true, usage: completion.usage,
      toolCalls: completion.toolCalls.length ? completion.toolCalls : undefined,
      toolCallsReady: completion.toolCalls.length > 0,
    };
    return;
  }
  // A finish_reason is also a terminal completion when a server omits [DONE].
  if (!done && !finishReason) throw protocolError('Completion stream ended before its terminal frame.', provider);
  const toolCalls = checkToolCalls([...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call), provider);
  if (!output.trim() && !toolCalls.length) throw protocolError('Endpoint returned an empty stream.', provider);
  yield {
    content: '', complete: true, usage, toolCalls: toolCalls.length ? toolCalls : undefined,
    toolCallsReady: toolCalls.length > 0, ...(emittedReasoning ? { reasoningComplete: true } : {}),
  };
}
