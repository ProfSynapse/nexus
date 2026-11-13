import type { LLMProviderConfig } from '../../../../types';
import type { OpenAICompatibleModelDefinition, ThinkingEffort } from '../../../../types/llm/ProviderTypes';
import { ProviderHttpClient } from '../shared/ProviderHttpClient';
import { resolveDefinitionThinking } from '../shared/CompatibleEndpointUtils';
import {
  probeOpenAICompatibleThinking,
  readReportedThinkingMetadata,
  type CompatibleThinkingProbeResult,
} from '../shared/CompatibleThinkingProbe';
import { getContextWindowOverrideKey } from '../../../../ui/chat/utils/ContextWindowSettings';
import type { ModelInfo } from '../types';

export const OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS = 600_000;
/** Used only when neither the user nor the server has given a context window. */
export const OPENAI_COMPATIBLE_CONTEXT_WINDOW = 4096;
export const OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS = 1024;
export const OPENAI_COMPATIBLE_MIN_CONTEXT_WINDOW = 256;
/** Rejects typos such as an extra digit group; no current model is near this. */
export const OPENAI_COMPATIBLE_MAX_CONTEXT_WINDOW = 16_777_216;

export function isOpenAICompatibleContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= OPENAI_COMPATIBLE_MIN_CONTEXT_WINDOW && value <= OPENAI_COMPATIBLE_MAX_CONTEXT_WINDOW;
}

export type OpenAICompatibleContextSource = 'user' | 'server' | 'default';

/** The user's value wins, then what the server reported, then the conservative default. */
export function resolveOpenAICompatibleContextWindow(
  definition: OpenAICompatibleModelDefinition | undefined,
): { contextWindow: number; source: OpenAICompatibleContextSource } {
  if (isOpenAICompatibleContextWindow(definition?.contextWindow)) return { contextWindow: definition.contextWindow, source: 'user' };
  if (isOpenAICompatibleContextWindow(definition?.reportedContextWindow)) {
    return { contextWindow: definition.reportedContextWindow, source: 'server' };
  }
  return { contextWindow: OPENAI_COMPATIBLE_CONTEXT_WINDOW, source: 'default' };
}

/** Persisted model IDs remain available even when the server is offline. */
export function buildOpenAICompatibleModels(config: LLMProviderConfig): ModelInfo[] {
  const definitions = config.openaiCompatible?.models ?? {};
  return Object.keys(definitions)
    .filter(id => isOpenAICompatibleModelId(id) && config.models?.[id]?.enabled !== false)
    .map(id => ({
      id, name: id, contextWindow: resolveOpenAICompatibleContextWindow(definitions[id]).contextWindow,
      maxOutputTokens: OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS,
      supportsStreaming: true, supportsFunctions: true,
      supportsThinking: resolveDefinitionThinking(definitions[id]).supportsThinking ?? true,
      supportsImages: false, supportsJSON: false, pricing: null,
    }));
}

export interface ContextOverrideRelease {
  map: Record<string, number>;
  key: string;
  value: number;
}

/**
 * Saving chat settings stores the model's whole window as its override, so a
 * model that sat at the 4,096 fallback carries an override of exactly 4,096.
 * When an endpoint save raises a model's window, an override equal to the old
 * maximum meant "use all of it" and would otherwise pin the chat at the old
 * size; it is removed. Smaller overrides were deliberate and stay. Returns what
 * was removed so a failed save can put it back.
 */
export function releaseRaisedContextOverrides(
  providerId: string,
  previous: LLMProviderConfig | undefined,
  next: LLMProviderConfig,
  overrideMaps: Array<Record<string, number> | undefined>,
): ContextOverrideRelease[] {
  const released: ContextOverrideRelease[] = [];
  const before = previous?.openaiCompatible?.models;
  if (!before) return released;
  for (const [model, definition] of Object.entries(next.openaiCompatible?.models ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(before, model)) continue;
    const oldMaximum = resolveOpenAICompatibleContextWindow(before[model]).contextWindow;
    if (resolveOpenAICompatibleContextWindow(definition).contextWindow <= oldMaximum) continue;
    const key = getContextWindowOverrideKey(providerId, model);
    for (const map of overrideMaps) {
      if (map?.[key] !== oldMaximum) continue;
      released.push({ map, key, value: oldMaximum });
      delete map[key];
    }
  }
  return released;
}

export function normalizeOpenAICompatibleBaseUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS for remote endpoints; HTTP is allowed only for localhost.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Enter an API base URL without credentials, query parameters, or a fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (/\/(?:chat\/completions|completions|models)$/i.test(url.pathname)) {
    throw new Error('Enter the API base URL, not a models or completions URL.');
  }
  return url.href.replace(/\/+$/, '');
}

export function openAICompatibleHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  return headers;
}

export function isOpenAICompatibleModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function validateOpenAICompatibleConfig(config: LLMProviderConfig): string {
  const endpoint = config.openaiCompatible;
  if (!endpoint || endpoint.schemaVersion !== 1 || typeof endpoint.displayName !== 'string'
    || !endpoint.displayName.trim() || !endpoint.models || typeof endpoint.models !== 'object'
    || Array.isArray(endpoint.models)) {
    throw new Error('OpenAI-compatible endpoint settings are incomplete.');
  }
  for (const [id, definition] of Object.entries(endpoint.models)) {
    if (!isOpenAICompatibleModelId(id)
      || !definition || !['manual', 'discovered'].includes(definition.source)) {
      throw new Error('OpenAI-compatible model definitions are invalid.');
    }
  }
  return normalizeOpenAICompatibleBaseUrl(endpoint.baseUrl);
}

export interface DiscoveredOpenAICompatibleModel {
  id: string;
  /** Present only when the server reported the context it actually serves. */
  contextWindow?: number;
  /** Present only when the server explicitly advertised or disabled thinking/reasoning. */
  supportsThinking?: boolean;
  /** Present only when the server advertised distinct thinking effort tiers. */
  thinkingEfforts?: ThinkingEffort[];
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return isOpenAICompatibleContextWindow(parsed) ? parsed : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Field names servers use for the context they serve, most specific first:
 * vLLM/SGLang `max_model_len`; OpenRouter, Together and Bifrost `context_length`;
 * Groq and Bifrost's OpenAI route `context_window`; Mistral and LM Studio
 * `max_context_length`; OpenRouter `top_provider.context_length`.
 * llama.cpp's `meta.n_ctx_train` is deliberately absent: it is the trained
 * maximum, not what the server allocated, so it comes from `/props` instead.
 */
export function readReportedContextWindow(entry: unknown): number | undefined {
  const item = record(entry);
  if (!item) return undefined;
  for (const key of ['max_model_len', 'context_length', 'context_window', 'max_context_length']) {
    const value = positiveInteger(item[key]);
    if (value !== undefined) return value;
  }
  return positiveInteger(record(item.top_provider)?.context_length);
}

/** llama.cpp serves `/props` beside `/v1`; its slot context is what one request can use. */
async function readLlamaCppContextWindow(baseUrl: string, apiKey: string): Promise<number | undefined> {
  try {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/v1$/i, '');
    const response = await ProviderHttpClient.request<unknown>({
      url: `${url.href.replace(/\/+$/, '')}/props`,
      provider: 'openai-compatible', operation: 'context discovery', method: 'GET',
      headers: openAICompatibleHeaders(apiKey), timeoutMs: 10_000, retries: 0,
    });
    if (!response.ok) return undefined;
    const props = record(response.json);
    return positiveInteger(record(props?.default_generation_settings)?.n_ctx) ?? positiveInteger(props?.n_ctx);
  } catch {
    return undefined;
  }
}

/** Discovery only: never sends a generation request or invents a model identifier. */
export async function discoverOpenAICompatibleModels(baseUrl: string, apiKey: string): Promise<DiscoveredOpenAICompatibleModel[]> {
  const normalized = normalizeOpenAICompatibleBaseUrl(baseUrl);
  const response = await ProviderHttpClient.request<unknown>({
    url: `${normalized}/models`,
    provider: 'openai-compatible', operation: 'model discovery', method: 'GET',
    headers: openAICompatibleHeaders(apiKey), timeoutMs: 30_000, retries: 0,
  });
  ProviderHttpClient.assertOk(response, `Model discovery failed: HTTP ${response.status}`);
  const data = response.json;
  if (!data || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>).data)) {
    throw new Error('Model discovery did not return a data array. Add a model ID manually.');
  }
  const entries = (data as { data: unknown[] }).data;
  const models = new Map<string, DiscoveredOpenAICompatibleModel>();
  for (const entry of entries) {
    const id = record(entry)?.id;
    if (!isOpenAICompatibleModelId(id) || models.has(id)) continue;
    const contextWindow = readReportedContextWindow(entry);
    const thinking = readReportedThinkingMetadata(entry);
    const discovered: DiscoveredOpenAICompatibleModel = { id };
    if (contextWindow !== undefined) discovered.contextWindow = contextWindow;
    if (thinking.supportsThinking !== undefined) discovered.supportsThinking = thinking.supportsThinking;
    if (thinking.thinkingEfforts !== undefined) discovered.thinkingEfforts = thinking.thinkingEfforts;
    models.set(id, discovered);
  }
  // A single-model llama.cpp server marks its entry with `meta`; ask it what it allocated.
  const only = models.size === 1 ? [...models.values()][0] : undefined;
  if (only && only.contextWindow === undefined && entries.some(entry => record(record(entry)?.meta))) {
    const contextWindow = await readLlamaCppContextWindow(normalized, apiKey);
    if (contextWindow !== undefined) only.contextWindow = contextWindow;
  }
  return [...models.values()];
}

export async function probeOpenAICompatibleModelThinking(request: {
  baseUrl: string;
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}): Promise<CompatibleThinkingProbeResult> {
  return probeOpenAICompatibleThinking({
    chatCompletionsUrl: `${normalizeOpenAICompatibleBaseUrl(request.baseUrl)}/chat/completions`,
    headers: openAICompatibleHeaders(request.apiKey),
    model: request.model,
    signal: request.signal,
  });
}
