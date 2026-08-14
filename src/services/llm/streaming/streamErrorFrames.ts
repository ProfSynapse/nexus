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

/** Code stamped on every LLMProviderError raised from an in-stream error frame. */
export const PROVIDER_STREAM_ERROR_CODE = 'PROVIDER_STREAM_ERROR';

/**
 * Build the error a processor throws when a stream carried a fatal error frame.
 * Callers (e.g. the LM Studio draft-model retry) branch on the code.
 */
export function createProviderStreamError(message: string, provider: string): LLMProviderError {
  return new LLMProviderError(message, provider, PROVIDER_STREAM_ERROR_CODE);
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
