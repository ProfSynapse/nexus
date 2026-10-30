/**
 * Overload Retry
 * Location: src/services/llm/adapters/shared/OverloadRetry.ts
 *
 * Retries a provider stream that failed because the provider is out of capacity
 * (OVERLOADED_STATUSES), with exponential backoff and jitter. That failure comes
 * either as an HTTP refusal before the stream opens or, from Anthropic, as an
 * `overloaded_error` frame right after an HTTP 200. Either way the provider did
 * no generation, so the request can be sent again.
 *
 * Retrying is only safe until the user has seen output, so chunks are held back
 * until the first one that carries any; after that a failure is final.
 *
 * Used by: StreamingOrchestrator, ToolContinuationService
 */
import { LLMProviderError, type StreamChunk } from '../types';
import { ProviderHttpError } from './ProviderHttpClient';
import { OVERLOADED_STATUSES } from './ProviderErrorMessages';

/** Retries after the first attempt: roughly 1s, 2s, 4s and 8s apart. */
export const OVERLOAD_MAX_RETRIES = 4;
const BASE_DELAY_MS = 1_000;
/** A provider asking for a longer wait than this gets its error shown instead. */
const MAX_REQUESTED_DELAY_MS = 20_000;

interface FailedResponse {
  status: number;
  headers?: Record<string, string | string[] | undefined>;
  json?: unknown;
}

function failedResponse(error: unknown): FailedResponse | null {
  if (error instanceof ProviderHttpError) return error.response;
  if (error instanceof LLMProviderError) {
    if (error.originalError instanceof ProviderHttpError) return error.originalError.response;
    if (typeof error.httpStatus === 'number') return { status: error.httpStatus };
  }
  return null;
}

function header(headers: FailedResponse['headers'], name: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * The wait the provider asked for, in ms: `retry-after-ms`, `retry-after`
 * (seconds or an HTTP date), or Google's RetryInfo `retryDelay` ("12.5s").
 */
function requestedDelayMs(response: FailedResponse, now: number): number | null {
  const ms = Number(header(response.headers, 'retry-after-ms'));
  if (Number.isFinite(ms) && ms >= 0) return ms;

  const retryAfter = header(response.headers, 'retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }

  const error = (response.json as { error?: { details?: unknown } } | null | undefined)?.error;
  if (Array.isArray(error?.details)) {
    for (const detail of error.details as Array<Record<string, unknown>>) {
      const delay = typeof detail?.retryDelay === 'string' ? /^([\d.]+)s$/.exec(detail.retryDelay) : null;
      if (delay) return Number(delay[1]) * 1000;
    }
  }
  return null;
}

/**
 * How long to wait before retry number `attempt + 1`, or null when the error is
 * not an overload, the retries are spent, or the provider wants too long a wait.
 */
export function overloadRetryDelayMs(
  error: unknown,
  attempt: number,
  random: () => number = Math.random,
  now: number = Date.now()
): number | null {
  const response = failedResponse(error);
  if (!response || !OVERLOADED_STATUSES.includes(response.status) || attempt >= OVERLOAD_MAX_RETRIES) {
    return null;
  }
  const requested = requestedDelayMs(response, now);
  if (requested !== null) return requested <= MAX_REQUESTED_DELAY_MS ? Math.ceil(requested) : null;

  // Equal jitter: half the exponential step, plus a random share of the other half,
  // so many clients refused at once do not all come back at the same instant.
  const step = BASE_DELAY_MS * 2 ** attempt;
  return Math.round(step / 2 + random() * (step / 2));
}

function carriesOutput(chunk: StreamChunk): boolean {
  return Boolean(chunk.content || chunk.reasoning || chunk.toolCalls?.length || chunk.complete);
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Request aborted', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Run `start()` and re-run it after an overload that arrives before any output.
 * Before each wait it yields a status-only chunk (`overloadRetry`) so the chat
 * can say it is retrying instead of showing a spinner with no explanation.
 */
export async function* streamWithOverloadRetry(
  start: () => AsyncIterable<StreamChunk>,
  signal?: AbortSignal,
  provider?: string
): AsyncGenerator<StreamChunk, void, unknown> {
  for (let attempt = 0; ; attempt++) {
    // Usage or metadata snapshots can precede an overload frame; they belong to
    // the refused attempt, so hold them until real output proves this one stuck.
    const held: StreamChunk[] = [];
    let committed = false;
    try {
      for await (const chunk of start()) {
        if (!committed && !carriesOutput(chunk)) {
          held.push(chunk);
          continue;
        }
        if (!committed) {
          committed = true;
          yield* held;
        }
        yield chunk;
      }
      if (!committed) yield* held;
      return;
    } catch (error) {
      const delay = committed || signal?.aborted ? null : overloadRetryDelayMs(error, attempt);
      if (delay === null) {
        // Not retried, so this attempt is the real one: its usage still counts.
        if (!committed) yield* held;
        throw error;
      }
      console.warn(`[OverloadRetry] Provider overloaded; retry ${attempt + 1} of ${OVERLOAD_MAX_RETRIES} in ${delay}ms`);
      yield {
        content: '',
        complete: false,
        overloadRetry: { provider, retry: attempt + 1, maxRetries: OVERLOAD_MAX_RETRIES, delayMs: delay }
      };
      await waitForRetry(delay, signal);
    }
  }
}
