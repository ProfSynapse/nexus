import {
  isOpenAICompatibleContextWindow,
  OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS,
} from '../openai-compatible/OpenAICompatibleConfig';
import {
  readContextLimitFromError,
  type OpenAICompatibleContextCheckResult,
} from '../openai-compatible/OpenAICompatibleContextCheck';
import { ProviderHttpClient } from './ProviderHttpClient';
import { TokenUsageExtractor } from '../../utils/TokenUsageExtractor';

export const COMPATIBLE_CONTEXT_FILLER = 'The quick brown fox jumps over the lazy dog. ';
const ASSUMED_TOKENS_PER_FILLER = 10;
const CALIBRATION_SMALL = 4;
const CALIBRATION_LARGE = 16;
const RESERVED_TOKENS = 8;
const TRUNCATION_RATIO = 0.9;
const CONTEXT_ERROR = /context|too long|too large|exceed|maximum.{0,40}(length|tokens)|max_model_len|n_ctx|prompt is too|token count/i;

export interface CompatibleContextProbeAttempt {
  ok: boolean;
  status: number;
  json: unknown;
  promptTokens?: number;
  detail: string;
}

function extractErrorDetail(json: unknown, text: string): string {
  if (json && typeof json === 'object') {
    const body = json as Record<string, unknown>;
    const nested = body.error;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
    if (nested && typeof nested === 'object') {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) return message.trim();
    }
    if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();
  }
  return text.trim().slice(0, 300);
}

export async function sendAnthropicMessagesContextProbe(params: {
  messagesUrl: string;
  provider: string;
  headers: Record<string, string>;
  model: string;
  repeats: number;
  signal?: AbortSignal;
}): Promise<CompatibleContextProbeAttempt> {
  const response = await ProviderHttpClient.request<unknown>({
    url: params.messagesUrl,
    provider: params.provider,
    operation: 'context check',
    method: 'POST',
    headers: params.headers,
    body: JSON.stringify({
      model: params.model,
      max_tokens: 1,
      messages: [{ role: 'user', content: COMPATIBLE_CONTEXT_FILLER.repeat(params.repeats) }],
    }),
    timeoutMs: OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS,
    signal: params.signal,
    retries: 0,
  });
  const body = response.json && typeof response.json === 'object' ? response.json as Record<string, unknown> : undefined;
  const promptTokens = TokenUsageExtractor.normalize(body?.usage)?.promptTokens;
  return {
    ok: response.ok,
    status: response.status,
    json: response.json,
    promptTokens: typeof promptTokens === 'number' && promptTokens > 0 ? promptTokens : undefined,
    detail: response.ok ? '' : extractErrorDetail(response.json, response.text),
  };
}

export async function sendGeminiV1BetaContextProbe(params: {
  v1betaBaseUrl: string;
  provider: string;
  headers: Record<string, string>;
  model: string;
  repeats: number;
  signal?: AbortSignal;
}): Promise<CompatibleContextProbeAttempt> {
  const cleanedModel = params.model.replace(/^models\//i, '').split('/').map(encodeURIComponent).join('/');
  const response = await ProviderHttpClient.request<unknown>({
    url: `${params.v1betaBaseUrl.replace(/\/+$/, '')}/models/${cleanedModel}:generateContent`,
    provider: params.provider,
    operation: 'context check',
    method: 'POST',
    headers: params.headers,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: COMPATIBLE_CONTEXT_FILLER.repeat(params.repeats) }] }],
      generationConfig: { maxOutputTokens: 1 },
    }),
    timeoutMs: OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS,
    signal: params.signal,
    retries: 0,
  });
  const body = response.json && typeof response.json === 'object' ? response.json as Record<string, unknown> : undefined;
  const usageSource = body?.usageMetadata ?? body?.usage;
  const promptTokens = TokenUsageExtractor.normalize(usageSource)?.promptTokens;
  return {
    ok: response.ok,
    status: response.status,
    json: response.json,
    promptTokens: typeof promptTokens === 'number' && promptTokens > 0 ? promptTokens : undefined,
    detail: response.ok ? '' : extractErrorDetail(response.json, response.text),
  };
}

export async function runCalibratedContextWindowCheck(
  contextWindow: number,
  sendProbe: (repeats: number) => Promise<CompatibleContextProbeAttempt>
): Promise<OpenAICompatibleContextCheckResult> {
  if (!isOpenAICompatibleContextWindow(contextWindow)) {
    return { kind: 'failed', message: 'Enter a context window before checking it.' };
  }
  const formatFailure = (attempt: CompatibleContextProbeAttempt): OpenAICompatibleContextCheckResult => ({
    kind: 'failed',
    message: `The server returned HTTP ${attempt.status}${attempt.detail ? `: ${attempt.detail}` : '.'}`,
  });

  const small = await sendProbe(CALIBRATION_SMALL);
  if (!small.ok) return formatFailure(small);
  const large = await sendProbe(CALIBRATION_LARGE);
  if (!large.ok) return formatFailure(large);

  const measured = small.promptTokens !== undefined && large.promptTokens !== undefined
    && large.promptTokens > small.promptTokens;
  const perRepeat = measured
    ? (large.promptTokens! - small.promptTokens!) / (CALIBRATION_LARGE - CALIBRATION_SMALL)
    : ASSUMED_TOKENS_PER_FILLER;
  const overhead = measured ? Math.max(0, small.promptTokens! - CALIBRATION_SMALL * perRepeat) : 0;
  const target = contextWindow - RESERVED_TOKENS;
  const repeats = Math.max(CALIBRATION_LARGE, Math.floor((target - overhead) / perRepeat));
  const expected = overhead + repeats * perRepeat;

  const full = await sendProbe(repeats);
  if (!full.ok) {
    const refusedForSize = full.status === 413 || CONTEXT_ERROR.test(full.detail);
    if (!refusedForSize) return formatFailure(full);
    return {
      kind: 'too-large',
      serverLimit: readContextLimitFromError(full.json, full.detail, contextWindow),
      message: full.detail || `The server refused the prompt (HTTP ${full.status}).`,
    };
  }
  if (!measured || full.promptTokens === undefined) return { kind: 'fits-unmeasured' };
  if (full.promptTokens < expected * TRUNCATION_RATIO) {
    return { kind: 'truncated', promptTokens: full.promptTokens };
  }
  return { kind: 'fits', promptTokens: full.promptTokens };
}
