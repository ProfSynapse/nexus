import { ProviderHttpClient } from '../shared/ProviderHttpClient';
import { TokenUsageExtractor } from '../../utils/TokenUsageExtractor';
import {
  isOpenAICompatibleContextWindow, normalizeOpenAICompatibleBaseUrl,
  OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS, openAICompatibleHeaders,
} from './OpenAICompatibleConfig';

/**
 * Asks the server whether a prompt of the chosen context size fits, because most
 * OpenAI-compatible servers never say. Runs only when the user presses Check:
 * a prompt that fits is read in full, which takes time locally and is billed by
 * hosted endpoints.
 */
export type OpenAICompatibleContextCheckResult =
  /** The server read about `promptTokens` tokens without complaint. */
  | { kind: 'fits'; promptTokens: number }
  /** Accepted, but the server reports no token counts, so silent truncation cannot be ruled out. */
  | { kind: 'fits-unmeasured' }
  /** Accepted, but the server read far fewer tokens than were sent: it cut the prompt down. */
  | { kind: 'truncated'; promptTokens: number }
  /** Refused as too long; `serverLimit` is the size the server named, when it named one. */
  | { kind: 'too-large'; serverLimit?: number; message: string }
  | { kind: 'failed'; message: string };

export interface OpenAICompatibleContextCheckRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  signal?: AbortSignal;
}

/** Ordinary prose tokenizes predictably; about ten tokens per repeat in common vocabularies. */
const FILLER = 'The quick brown fox jumps over the lazy dog. ';
const ASSUMED_TOKENS_PER_FILLER = 10;
const CALIBRATION_SMALL = 4;
const CALIBRATION_LARGE = 16;
/** Leaves room for one output token and rounding in the calibration. */
const RESERVED_TOKENS = 8;
/** A count this far under the prediction means the server dropped part of the prompt. */
const TRUNCATION_RATIO = 0.9;

const CONTEXT_ERROR = /context|too long|too large|exceed|maximum.{0,40}(length|tokens)|max_model_len|n_ctx|prompt is too/i;
const LIMIT_PATTERNS = [
  /maximum context length is (\d[\d,]*)/i,
  /max_model_len\D{0,5}(\d[\d,]*)/i,
  /\bn_ctx\b\D{0,5}(\d[\d,]*)/i,
  // llama.cpp: "exceeds the available context size (2048 tokens)".
  /context (?:length|size|window)(?: of| is|:)? \(?(\d[\d,]*)/i,
];

interface Attempt {
  ok: boolean;
  status: number;
  promptTokens?: number;
  detail: string;
  json: unknown;
}

function errorDetail(json: unknown, text: string): string {
  const body = json && typeof json === 'object' ? json as Record<string, unknown> : undefined;
  const error = body?.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, unknown>).message as string;
  }
  for (const key of ['message', 'detail']) {
    const value = body?.[key];
    if (typeof value === 'string') return value;
  }
  return text.slice(0, 500);
}

/** The limit a refusal names: llama.cpp sends `n_ctx` as a field, others put it in the sentence. */
export function readContextLimitFromError(json: unknown, detail: string, tested: number): number | undefined {
  const body = json && typeof json === 'object' ? json as Record<string, unknown> : undefined;
  const nested = body?.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : undefined;
  const candidates: unknown[] = [nested?.n_ctx, body?.n_ctx];
  for (const pattern of LIMIT_PATTERNS) {
    const match = pattern.exec(detail);
    if (match) candidates.push(Number(match[1].replace(/,/g, '')));
  }
  return candidates.find((value): value is number => isOpenAICompatibleContextWindow(value) && value < tested);
}

async function send(request: OpenAICompatibleContextCheckRequest, repeats: number): Promise<Attempt> {
  const response = await ProviderHttpClient.request<unknown>({
    url: `${normalizeOpenAICompatibleBaseUrl(request.baseUrl)}/chat/completions`,
    provider: 'openai-compatible', operation: 'context check', method: 'POST',
    headers: openAICompatibleHeaders(request.apiKey),
    body: JSON.stringify({
      model: request.model, stream: false, max_tokens: 1, temperature: 0,
      messages: [{ role: 'user', content: FILLER.repeat(repeats) }],
    }),
    timeoutMs: OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS, signal: request.signal, retries: 0,
  });
  const body = response.json && typeof response.json === 'object' ? response.json as Record<string, unknown> : undefined;
  const promptTokens = TokenUsageExtractor.normalize(body?.usage)?.promptTokens;
  return {
    ok: response.ok, status: response.status, json: response.json,
    promptTokens: typeof promptTokens === 'number' && promptTokens > 0 ? promptTokens : undefined,
    detail: response.ok ? '' : errorDetail(response.json, response.text),
  };
}

function failure(attempt: Attempt): OpenAICompatibleContextCheckResult {
  return { kind: 'failed', message: `The server returned HTTP ${attempt.status}${attempt.detail ? `: ${attempt.detail}` : '.'}` };
}

export async function checkOpenAICompatibleContextWindow(
  request: OpenAICompatibleContextCheckRequest,
): Promise<OpenAICompatibleContextCheckResult> {
  if (!isOpenAICompatibleContextWindow(request.contextWindow)) {
    return { kind: 'failed', message: 'Enter a context window before checking it.' };
  }
  // Two small prompts measure this tokenizer: tokens per repeat, and the fixed
  // cost of the chat template around the message.
  const small = await send(request, CALIBRATION_SMALL);
  if (!small.ok) return failure(small);
  const large = await send(request, CALIBRATION_LARGE);
  if (!large.ok) return failure(large);

  const measured = small.promptTokens !== undefined && large.promptTokens !== undefined
    && large.promptTokens > small.promptTokens;
  const perRepeat = measured
    ? (large.promptTokens! - small.promptTokens!) / (CALIBRATION_LARGE - CALIBRATION_SMALL)
    : ASSUMED_TOKENS_PER_FILLER;
  const overhead = measured ? Math.max(0, small.promptTokens! - CALIBRATION_SMALL * perRepeat) : 0;
  const target = request.contextWindow - RESERVED_TOKENS;
  const repeats = Math.max(CALIBRATION_LARGE, Math.floor((target - overhead) / perRepeat));
  const expected = overhead + repeats * perRepeat;

  const full = await send(request, repeats);
  if (!full.ok) {
    const refusedForSize = full.status === 413 || CONTEXT_ERROR.test(full.detail);
    if (!refusedForSize) return failure(full);
    return {
      kind: 'too-large',
      serverLimit: readContextLimitFromError(full.json, full.detail, request.contextWindow),
      message: full.detail || `The server refused the prompt (HTTP ${full.status}).`,
    };
  }
  if (!measured || full.promptTokens === undefined) return { kind: 'fits-unmeasured' };
  if (full.promptTokens < expected * TRUNCATION_RATIO) return { kind: 'truncated', promptTokens: full.promptTokens };
  return { kind: 'fits', promptTokens: full.promptTokens };
}
