/**
 * Provider error frames delivered over HTTP 200
 * Location: src/services/llm/streaming/streamErrorFrames.ts
 *
 * Several providers answer a streaming request with HTTP 200 and then push a
 * fatal error as a data frame instead of content -- OpenAI-compatible routers
 * send `{"error": {...}}`, Anthropic sends `{"type":"error","error":{...}}`,
 * Ollama sends `{"error":"..."}` on an NDJSON line. Nothing in the frame matches
 * a content/tool-call/finish-reason extractor, so without explicit handling the
 * stream simply ends: blank chat bubble, empty log.
 *
 * Every frame-parsing processor in this layer funnels such a frame through
 * `createProviderStreamError` so callers see one error type with one code,
 * regardless of which processor or transport produced it.
 */

import { LLMProviderError } from '../adapters/types';
import { describeProviderHttpFailure } from '../adapters/shared/ProviderErrorMessages';

/** Code stamped on every LLMProviderError raised from an in-stream error frame. */
export const PROVIDER_STREAM_ERROR_CODE = 'PROVIDER_STREAM_ERROR';

/**
 * HTTP-equivalent status for the error labels providers put in a frame:
 * Anthropic `error.type`, google.rpc.Status `error.status`, OpenAI `error.code`.
 */
const STATUS_BY_ERROR_LABEL: Record<string, number> = {
  overloaded_error: 529,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  invalid_request_error: 400,
  request_too_large: 413,
  UNAVAILABLE: 503,
  RESOURCE_EXHAUSTED: 429,
  INTERNAL: 500,
  DEADLINE_EXCEEDED: 504,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  INVALID_ARGUMENT: 400,
  server_error: 500,
  rate_limit_exceeded: 429,
  insufficient_quota: 429,
  invalid_api_key: 401,
  model_not_found: 404,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The HTTP status an error frame stands for, or null when it carries nothing
 * recognisable. Handles `{"error":{...}}`, Anthropic's `{"type":"error","error":{...}}`
 * and the Responses API's `{"type":"error","code":...}` / `response.failed` frames.
 */
export function streamErrorFrameStatus(frame: unknown): number | null {
  const record = asRecord(frame);
  if (!record) return null;
  const error = asRecord(record.error)
    ?? asRecord(asRecord(record.response)?.error)
    ?? (record.type === 'error' ? record : null);
  if (!error) return null;

  if (typeof error.code === 'number' && error.code >= 400 && error.code < 600) return error.code;
  for (const label of [error.type, error.status, error.code]) {
    if (typeof label === 'string' && label in STATUS_BY_ERROR_LABEL) return STATUS_BY_ERROR_LABEL[label];
  }
  return null;
}

/**
 * Build the error a processor throws when a stream carried a fatal error frame.
 * Callers (e.g. the LM Studio draft-model retry) branch on the code. When the
 * frame names a status, `message` becomes the same plain-language sentence an
 * HTTP failure gets; the provider's own words stay on `technicalMessage`.
 */
export function createProviderStreamError(message: string, provider: string, frame?: unknown): LLMProviderError {
  const status = streamErrorFrameStatus(frame);
  const error = new LLMProviderError(
    status === null ? message : describeProviderHttpFailure(provider, status, message),
    provider,
    PROVIDER_STREAM_ERROR_CODE
  );
  error.technicalMessage = message;
  if (status !== null) error.httpStatus = status;
  return error;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Conservative default extractor for a top-level `error` member.
 *
 * Recognises the shapes shared by essentially every OpenAI-compatible surface:
 *   {"error": {"message": "...", "code": 429, "type": "..."}}
 *   {"error": "plain string"}
 *   {"object": "error", "message": "..."}      // Mistral's error body shape
 *
 * Deliberately narrow: it only fires on a truthy top-level `error` (or the
 * explicit `object: "error"` marker), so a normal content frame can never be
 * mistaken for a failure. Returns null when there is nothing error-shaped.
 *
 * @param fallbackMessage used when the frame is error-shaped but carries no
 *   human-readable text, so an unrecognised error still fails loudly.
 */
export function extractStreamErrorMessage(
  parsed: unknown,
  fallbackMessage = 'Provider reported an error mid-stream'
): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const frame = parsed as Record<string, unknown>;
  const rawError = frame.error;

  if (rawError === undefined || rawError === null || rawError === false) {
    // Mistral-style: the frame itself is the error object.
    if (frame.object === 'error') {
      return firstNonEmptyString(frame.message, frame.detail, frame.type) ?? fallbackMessage;
    }
    return null;
  }

  if (typeof rawError === 'string') {
    return rawError.trim().length > 0 ? rawError.trim() : fallbackMessage;
  }

  if (typeof rawError === 'object') {
    const errorObject = rawError as Record<string, unknown>;
    const message = firstNonEmptyString(
      errorObject.message,
      errorObject.detail,
      errorObject.reason
    );
    if (message) {
      return message;
    }
    const label = firstNonEmptyString(errorObject.type, errorObject.status);
    if (label) {
      return `${fallbackMessage}: ${label}`;
    }
    const code = errorObject.code;
    if (typeof code === 'number' || typeof code === 'string') {
      return `${fallbackMessage}: ${String(code)}`;
    }
  }

  // Truthy but shapeless (e.g. `error: true`) -- still an error, still must throw.
  return fallbackMessage;
}

/**
 * Error extractor for the OpenAI Responses API event stream, shared by every
 * adapter that speaks it (OpenAI, OpenAI Codex, GitHub Copilot's /responses path).
 *
 * The Responses stream reports a fatal failure over HTTP 200 in two ways:
 *   {"type":"error","code":"...","message":"..."}                 // stream-level
 *   {"type":"response.failed","response":{"error":{"message":...}}}
 *
 * `response.incomplete` is deliberately NOT treated as an error: a response
 * truncated by max_output_tokens still carries usable text.
 */
export function extractResponsesApiStreamError(
  event: unknown,
  fallbackMessage = 'Responses API streaming error'
): string | null {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const frame = event as Record<string, unknown>;
  const type = typeof frame.type === 'string' ? frame.type : '';

  if (type === 'error') {
    return (
      firstNonEmptyString(frame.message) ??
      extractStreamErrorMessage(frame, fallbackMessage) ??
      fallbackMessage
    );
  }

  if (type === 'response.failed' || type === 'response.error') {
    const response = frame.response;
    const fromResponse = extractStreamErrorMessage(response, fallbackMessage);
    return fromResponse ?? fallbackMessage;
  }

  // A bare {"error": {...}} frame with no Responses event type.
  return extractStreamErrorMessage(frame, fallbackMessage);
}
