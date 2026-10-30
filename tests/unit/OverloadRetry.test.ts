/**
 * #429: an overloaded provider is retried with backoff, but only until the
 * user has seen output. Each case below fails if that boundary moves.
 */
import { overloadRetryDelayMs, streamWithOverloadRetry, OVERLOAD_MAX_RETRIES } from '../../src/services/llm/adapters/shared/OverloadRetry';
import { ProviderHttpError } from '../../src/services/llm/adapters/shared/ProviderHttpClient';
import { createProviderStreamError } from '../../src/services/llm/streaming/streamErrorFrames';
import { LLMProviderError, type StreamChunk } from '../../src/services/llm/adapters/types';

function httpError(status: number, extra: { headers?: Record<string, string>; json?: unknown } = {}): ProviderHttpError {
  return new ProviderHttpError(`streaming generation failed with HTTP ${status}`, {
    status, statusText: `HTTP ${status}`, data: extra.json ?? null, text: '', json: extra.json ?? null, headers: extra.headers
  }, 'google');
}

const overloadedFrame = () => createProviderStreamError(
  'Overloaded', 'anthropic', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
);

/** Each call to the returned factory plays the next scripted attempt. */
function attempts(...scripts: Array<Array<StreamChunk | Error>>) {
  let calls = 0;
  const start = () => (async function* () {
    const script = scripts[calls++] ?? [];
    for (const step of script) {
      if (step instanceof Error) throw step;
      yield step;
    }
  })();
  return { start, calls: () => calls };
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('overloadRetryDelayMs', () => {
  it.each([0, 1, 2, 3])('backs off exponentially with jitter on retry %i', attempt => {
    const step = 1_000 * 2 ** attempt;
    expect(overloadRetryDelayMs(httpError(503), attempt, () => 0)).toBe(step / 2);
    expect(overloadRetryDelayMs(httpError(503), attempt, () => 1)).toBe(step);
  });

  it('stops after the last retry', () => {
    expect(overloadRetryDelayMs(httpError(503), OVERLOAD_MAX_RETRIES)).toBeNull();
  });

  it.each([429, 500, 400, 401])('does not retry HTTP %i', status => {
    expect(overloadRetryDelayMs(httpError(status), 0)).toBeNull();
  });

  it('recognises an overload frame and a wrapped HTTP error', () => {
    expect(overloadRetryDelayMs(overloadedFrame(), 0, () => 0)).toBe(500);
    // OpenRouter routes streaming HTTP failures through handleError.
    expect(overloadRetryDelayMs(new LLMProviderError('x', 'openrouter', 'SERVER_ERROR', httpError(503)), 0, () => 0)).toBe(500);
    expect(overloadRetryDelayMs(new Error('Overloaded'), 0)).toBeNull();
  });

  it.each([
    ['retry-after seconds', { headers: { 'Retry-After': '3' } }, 3_000],
    ['retry-after-ms', { headers: { 'retry-after-ms': '1500' } }, 1_500],
    ['retry-after date', { headers: { 'retry-after': new Date(10_000).toUTCString() } }, 10_000],
    ['Google RetryInfo', { json: { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2.5s' }] } } }, 2_500],
  ])('honours %s', (_label, extra, expected) => {
    expect(overloadRetryDelayMs(httpError(503, extra), 0, () => 0, 0)).toBe(expected);
  });

  it('shows the error instead of waiting when the provider asks for too long', () => {
    expect(overloadRetryDelayMs(httpError(503, { headers: { 'retry-after': '60' } }), 0)).toBeNull();
  });
});

describe('streamWithOverloadRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('retries an HTTP refusal and streams the eventual answer', async () => {
    const script = attempts([httpError(503)], [httpError(503)], [{ content: 'hi', complete: true }]);
    const pending = drain(streamWithOverloadRetry(script.start, undefined, 'google'));
    await jest.advanceTimersByTimeAsync(10_000);
    const chunks = await pending;

    // One status chunk per retry, numbered X of Y, then the real answer.
    expect(chunks.map(chunk => chunk.overloadRetry && [chunk.overloadRetry.retry, chunk.overloadRetry.maxRetries]))
      .toEqual([[1, OVERLOAD_MAX_RETRIES], [2, OVERLOAD_MAX_RETRIES], undefined]);
    expect(chunks[0]).toMatchObject({ content: '', complete: false, overloadRetry: { provider: 'google' } });
    expect(chunks.at(-1)).toEqual({ content: 'hi', complete: true });
    expect(script.calls()).toBe(3);
  });

  it('retries an overload frame after HTTP 200 and drops the refused attempt\'s usage snapshot', async () => {
    const staleUsage = { content: '', complete: false, usage: { promptTokens: 9, completionTokens: 0, totalTokens: 9 } };
    const script = attempts([staleUsage, overloadedFrame()], [{ content: 'ok', complete: true }]);
    const pending = drain(streamWithOverloadRetry(script.start));
    await jest.advanceTimersByTimeAsync(10_000);
    const chunks = await pending;
    expect(chunks.filter(chunk => !chunk.overloadRetry)).toEqual([{ content: 'ok', complete: true }]);
    expect(chunks.filter(chunk => chunk.overloadRetry)).toHaveLength(1);
  });

  it('never replays once output has been shown', async () => {
    const script = attempts([{ content: 'partial', complete: false }, overloadedFrame()], [{ content: 'again', complete: true }]);
    const seen: string[] = [];
    await expect((async () => {
      for await (const chunk of streamWithOverloadRetry(script.start)) seen.push(chunk.content);
    })()).rejects.toThrow('Anthropic is overloaded right now');
    expect(seen).toEqual(['partial']);
    expect(script.calls()).toBe(1);
  });

  it('gives up with the readable error after the last retry', async () => {
    const script = attempts(...Array.from({ length: OVERLOAD_MAX_RETRIES + 2 }, () => [httpError(503)]));
    const pending = drain(streamWithOverloadRetry(script.start)).then(() => null, (error: unknown) => error);
    await jest.advanceTimersByTimeAsync(60_000);
    expect((await pending as Error).message).toBe(
      'Google AI is overloaded right now. Wait a moment and try again, or switch to a different model. (HTTP 503)'
    );
    expect(script.calls()).toBe(OVERLOAD_MAX_RETRIES + 1);
  });

  it('still delivers held usage when the failure is not retried', async () => {
    const usage = { content: '', complete: false, usage: { promptTokens: 150, completionTokens: 7, totalTokens: 157 } };
    const seen: StreamChunk[] = [];
    await expect((async () => {
      for await (const chunk of streamWithOverloadRetry(attempts([usage, new Error('Stream interrupted')]).start)) seen.push(chunk);
    })()).rejects.toThrow('Stream interrupted');
    expect(seen).toEqual([usage]);
  });

  it('does not retry anything that is not an overload', async () => {
    const script = attempts([httpError(429)], [{ content: 'never', complete: true }]);
    await expect(drain(streamWithOverloadRetry(script.start))).rejects.toThrow('rate limit or usage quota');
    expect(script.calls()).toBe(1);
  });

  it('stops waiting when the user aborts', async () => {
    const script = attempts([httpError(503)], [{ content: 'never', complete: true }]);
    const controller = new AbortController();
    const pending = drain(streamWithOverloadRetry(script.start, controller.signal)).then(() => null, (error: unknown) => error);
    await jest.advanceTimersByTimeAsync(100);
    controller.abort();
    expect((await pending as Error).name).toBe('AbortError');
    expect(script.calls()).toBe(1);
  });

  it('passes a stream with no output-bearing chunks through unchanged', async () => {
    const meta = { content: '', complete: false, metadata: { id: 'x' } };
    expect(await drain(streamWithOverloadRetry(attempts([meta]).start))).toEqual([meta]);
  });
});
