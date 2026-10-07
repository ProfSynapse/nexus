import type { LLMProviderConfig } from '../../../../types';
import { ProviderHttpClient } from '../shared/ProviderHttpClient';
import type { ModelInfo } from '../types';

export const OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS = 600_000;
export const OPENAI_COMPATIBLE_CONTEXT_WINDOW = 4096;
export const OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS = 1024;

/** Persisted model IDs remain available even when the server is offline. */
export function buildOpenAICompatibleModels(config: LLMProviderConfig): ModelInfo[] {
  return Object.keys(config.openaiCompatible?.models ?? {})
    .filter(id => isOpenAICompatibleModelId(id) && config.models?.[id]?.enabled !== false)
    .map(id => ({
      id, name: id, contextWindow: OPENAI_COMPATIBLE_CONTEXT_WINDOW,
      maxOutputTokens: OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS,
      supportsStreaming: true, supportsFunctions: true, supportsThinking: true,
      supportsImages: false, supportsJSON: false, pricing: null,
    }));
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

/** Discovery only: never sends a generation request or invents a model identifier. */
export async function discoverOpenAICompatibleModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const response = await ProviderHttpClient.request<unknown>({
    url: `${normalizeOpenAICompatibleBaseUrl(baseUrl)}/models`,
    provider: 'openai-compatible', operation: 'model discovery', method: 'GET',
    headers: openAICompatibleHeaders(apiKey), timeoutMs: 30_000, retries: 0,
  });
  ProviderHttpClient.assertOk(response, `Model discovery failed: HTTP ${response.status}`);
  const data = response.json;
  if (!data || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>).data)) {
    throw new Error('Model discovery did not return a data array. Add a model ID manually.');
  }
  const ids = (data as { data: unknown[] }).data.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const id = (item as Record<string, unknown>).id;
    return isOpenAICompatibleModelId(id) ? [id] : [];
  });
  return [...new Set(ids)];
}
