import type {
  AnthropicCompatibleAuthMode,
  AntigravityCompatibleAuthMode,
  AntigravityCompatibleWireProtocol,
  LLMProviderConfig,
  OpenAICompatibleModelDefinition,
} from '../../../../types/llm/ProviderTypes';
import type { ModelInfo } from '../types';
import { ANTHROPIC_MODELS } from '../anthropic/AnthropicModels';
import { GOOGLE_MODELS } from '../google/GoogleModels';
import {
  isOpenAICompatibleContextWindow,
  isOpenAICompatibleModelId,
  type DiscoveredOpenAICompatibleModel,
  type OpenAICompatibleContextSource,
} from '../openai-compatible/OpenAICompatibleConfig';
import type { OpenAICompatibleContextCheckResult } from '../openai-compatible/OpenAICompatibleContextCheck';
import { parseDiscoveredModelEntries } from '../anthropic-compatible/AnthropicCompatibleConfig';
import { ProviderHttpClient } from '../shared/ProviderHttpClient';
import {
  isClaudeFamilyModelId,
  resolveAntigravityModelWire,
  resolveDefinitionThinking,
  stripCompatibleModelPrefix,
} from '../shared/CompatibleEndpointUtils';
import {
  probeAnthropicMessagesThinking,
  probeGeminiV1BetaThinking,
  type CompatibleThinkingProbeResult,
} from '../shared/CompatibleThinkingProbe';
import {
  runCalibratedContextWindowCheck,
  sendAnthropicMessagesContextProbe,
  sendGeminiV1BetaContextProbe,
} from '../shared/CompatibleContextCheck';

export const ANTIGRAVITY_COMPATIBLE_CONTEXT_WINDOW = 200_000;
export const ANTIGRAVITY_COMPATIBLE_GEMINI_CONTEXT_WINDOW = 1_048_576;
export const ANTIGRAVITY_COMPATIBLE_MAX_OUTPUT_TOKENS = 32_768;

function findAntigravityKnownDefaults(modelId: string): { contextWindow?: number; maxTokens?: number } {
  const bare = stripCompatibleModelPrefix(modelId);
  const googleMatch = GOOGLE_MODELS.find(model => model.apiName === bare);
  if (googleMatch) {
    return { contextWindow: googleMatch.contextWindow, maxTokens: googleMatch.maxTokens };
  }
  const anthropicMatch = ANTHROPIC_MODELS.find(model => model.apiName === bare);
  if (anthropicMatch) {
    return {
      contextWindow: anthropicMatch.contextWindow,
      maxTokens: anthropicMatch.maxTokens ? Math.min(anthropicMatch.maxTokens, 64_000) : undefined,
    };
  }
  if (/^gemini-[34]/i.test(bare) || bare === 'gemini-pro-agent') {
    return { contextWindow: ANTIGRAVITY_COMPATIBLE_GEMINI_CONTEXT_WINDOW, maxTokens: ANTIGRAVITY_COMPATIBLE_MAX_OUTPUT_TOKENS };
  }
  return {};
}

export function resolveAntigravityCompatibleContextWindow(
  definition: OpenAICompatibleModelDefinition | undefined,
  modelId?: string,
): { contextWindow: number; source: OpenAICompatibleContextSource } {
  if (isOpenAICompatibleContextWindow(definition?.contextWindow)) {
    return { contextWindow: definition.contextWindow, source: 'user' };
  }
  if (isOpenAICompatibleContextWindow(definition?.reportedContextWindow)) {
    return { contextWindow: definition.reportedContextWindow, source: 'server' };
  }
  const known = modelId ? findAntigravityKnownDefaults(modelId).contextWindow : undefined;
  const fallback = modelId && !isClaudeFamilyModelId(modelId) && /^gemini-/i.test(stripCompatibleModelPrefix(modelId))
    ? ANTIGRAVITY_COMPATIBLE_GEMINI_CONTEXT_WINDOW
    : ANTIGRAVITY_COMPATIBLE_CONTEXT_WINDOW;
  return {
    contextWindow: isOpenAICompatibleContextWindow(known) ? known : fallback,
    source: 'default',
  };
}

export function buildAntigravityCompatibleModels(config: LLMProviderConfig): ModelInfo[] {
  const definitions = config.antigravityCompatible?.models ?? {};
  return Object.keys(definitions)
    .filter(id => isOpenAICompatibleModelId(id) && config.models?.[id]?.enabled !== false)
    .map(id => {
      const defaults = findAntigravityKnownDefaults(id);
      return {
        id,
        name: id,
        contextWindow: resolveAntigravityCompatibleContextWindow(definitions[id], id).contextWindow,
        maxOutputTokens: defaults.maxTokens ?? ANTIGRAVITY_COMPATIBLE_MAX_OUTPUT_TOKENS,
        supportsStreaming: true,
        supportsFunctions: true,
        supportsThinking: resolveDefinitionThinking(definitions[id]).supportsThinking ?? true,
        supportsImages: true,
        supportsJSON: true,
        pricing: null,
      };
    });
}

export function normalizeAntigravityCompatibleBaseUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS for remote endpoints; HTTP is allowed only for localhost.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Enter an API base URL without credentials, query parameters, or a fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (/(?::(?:stream)?generateContent|\/(?:messages|chat\/completions|completions|models))$/i.test(url.pathname)) {
    throw new Error('Enter the gateway base URL, not a models or generation URL.');
  }
  return url.href.replace(/\/+$/, '');
}

export interface ResolvedAntigravityCompatibleUrls {
  baseUrl: string;
  gatewayRootUrl: string;
  v1betaBaseUrl: string;
  v1BaseUrl: string;
  messagesUrl: string;
  v1betaModelsUrl: string;
  v1ModelsUrls: string[];
}

export function resolveAntigravityCompatibleUrls(baseUrl: string): ResolvedAntigravityCompatibleUrls {
  const normalized = normalizeAntigravityCompatibleBaseUrl(baseUrl);
  const rootParsed = new URL(normalized);
  rootParsed.pathname = rootParsed.pathname.replace(/\/(?:v1beta|v1)$/i, '');
  const gatewayRootUrl = rootParsed.href.replace(/\/+$/, '');
  const v1betaBaseUrl = `${gatewayRootUrl}/v1beta`;
  const v1BaseUrl = `${gatewayRootUrl}/v1`;
  const messagesUrl = `${v1BaseUrl}/messages`;
  return {
    baseUrl: normalized,
    gatewayRootUrl,
    v1betaBaseUrl,
    v1BaseUrl,
    messagesUrl,
    v1betaModelsUrl: `${v1betaBaseUrl}/models`,
    v1ModelsUrls: [`${v1BaseUrl}/models`, `${gatewayRootUrl}/models`],
  };
}

export function toAnthropicAuthMode(
  authMode: AntigravityCompatibleAuthMode = 'both'
): AnthropicCompatibleAuthMode {
  if (authMode === 'bearer') return 'bearer';
  if (authMode === 'header-key') return 'x-api-key';
  return 'both';
}

export function antigravityV1BetaHeaders(
  apiKey: string,
  authMode: AntigravityCompatibleAuthMode = 'both',
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = apiKey.trim();
  if (key) {
    if (authMode === 'header-key' || authMode === 'both') {
      headers['x-goog-api-key'] = key;
    }
    if (authMode === 'bearer' || authMode === 'both') {
      headers.Authorization = `Bearer ${key}`;
    }
  }
  return headers;
}

export function antigravityMessagesHeaders(
  apiKey: string,
  authMode: AntigravityCompatibleAuthMode = 'both',
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  const key = apiKey.trim();
  if (key) {
    if (authMode === 'header-key' || authMode === 'both') {
      headers['x-api-key'] = key;
    }
    if (authMode === 'bearer' || authMode === 'both') {
      headers.Authorization = `Bearer ${key}`;
    }
  }
  return headers;
}

export function validateAntigravityCompatibleConfig(
  config: LLMProviderConfig
): ResolvedAntigravityCompatibleUrls {
  const endpoint = config.antigravityCompatible;
  if (!endpoint || endpoint.schemaVersion !== 1 || typeof endpoint.displayName !== 'string'
    || !endpoint.displayName.trim() || !endpoint.models || typeof endpoint.models !== 'object'
    || Array.isArray(endpoint.models)) {
    throw new Error('Antigravity-compatible endpoint settings are incomplete.');
  }
  for (const [id, definition] of Object.entries(endpoint.models)) {
    if (!isOpenAICompatibleModelId(id)
      || !definition || !['manual', 'discovered'].includes(definition.source)) {
      throw new Error('Antigravity-compatible model definitions are invalid.');
    }
  }
  return resolveAntigravityCompatibleUrls(endpoint.baseUrl);
}

async function tryDiscoverFromUrls(
  urls: string[],
  headers: Record<string, string>,
): Promise<{ ok: true; models: DiscoveredOpenAICompatibleModel[] } | { ok: false; error: Error }> {
  let lastError: Error = new Error('Model discovery failed.');
  for (let index = 0; index < urls.length; index++) {
    try {
      const response = await ProviderHttpClient.request<unknown>({
        url: urls[index],
        provider: 'antigravity-compatible',
        operation: 'model discovery',
        method: 'GET',
        headers,
        timeoutMs: 30_000,
        retries: 0,
      });
      if (!response.ok) {
        if (response.status === 404 && index < urls.length - 1) {
          continue;
        }
        ProviderHttpClient.assertOk(response, `Model discovery failed: HTTP ${response.status}`);
      }
      const parsed = parseDiscoveredModelEntries(response.json);
      if (!parsed) {
        lastError = new Error('Model discovery did not return a models list. Add a model ID manually.');
        continue;
      }
      return { ok: true, models: parsed };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  return { ok: false, error: lastError };
}

export async function discoverAntigravityCompatibleModels(
  baseUrl: string,
  apiKey: string,
  wireProtocol: AntigravityCompatibleWireProtocol = 'auto',
  authMode: AntigravityCompatibleAuthMode = 'both',
): Promise<DiscoveredOpenAICompatibleModel[]> {
  const urls = resolveAntigravityCompatibleUrls(baseUrl);
  const v1betaHeaders = antigravityV1BetaHeaders(apiKey, authMode);
  const messagesHeaders = antigravityMessagesHeaders(apiKey, authMode);

  if (wireProtocol === 'v1beta') {
    const res = await tryDiscoverFromUrls([urls.v1betaModelsUrl, ...urls.v1ModelsUrls], v1betaHeaders);
    if (!res.ok) throw res.error;
    return res.models;
  }

  if (wireProtocol === 'messages') {
    const res = await tryDiscoverFromUrls(urls.v1ModelsUrls, messagesHeaders);
    if (!res.ok) throw res.error;
    return res.models;
  }

  const [v1betaRes, messagesRes] = await Promise.all([
    tryDiscoverFromUrls([urls.v1betaModelsUrl], v1betaHeaders),
    tryDiscoverFromUrls(urls.v1ModelsUrls, messagesHeaders),
  ]);

  if (!v1betaRes.ok && !messagesRes.ok) {
    throw v1betaRes.error;
  }

  const merged = new Map<string, DiscoveredOpenAICompatibleModel>();
  for (const source of [v1betaRes, messagesRes]) {
    if (!source.ok) continue;
    for (const model of source.models) {
      const existing = merged.get(model.id);
      if (!existing) {
        merged.set(model.id, { ...model });
        continue;
      }
      if (existing.contextWindow === undefined && model.contextWindow !== undefined) {
        existing.contextWindow = model.contextWindow;
      }
      if (existing.supportsThinking === undefined && model.supportsThinking !== undefined) {
        existing.supportsThinking = model.supportsThinking;
      }
      if (existing.thinkingEfforts === undefined && model.thinkingEfforts !== undefined) {
        existing.thinkingEfforts = model.thinkingEfforts;
      }
    }
  }
  return [...merged.values()];
}

export async function checkAntigravityCompatibleContextWindow(request: {
  baseUrl: string;
  apiKey: string;
  wireProtocol?: AntigravityCompatibleWireProtocol;
  authMode?: AntigravityCompatibleAuthMode;
  model: string;
  contextWindow: number;
  signal?: AbortSignal;
}): Promise<OpenAICompatibleContextCheckResult> {
  const urls = resolveAntigravityCompatibleUrls(request.baseUrl);
  const authMode = request.authMode ?? 'both';
  const wire = resolveAntigravityModelWire(request.model, request.wireProtocol ?? 'auto');
  if (wire === 'anthropic') {
    const headers = antigravityMessagesHeaders(request.apiKey, authMode);
    return runCalibratedContextWindowCheck(request.contextWindow, repeats =>
      sendAnthropicMessagesContextProbe({
        messagesUrl: urls.messagesUrl,
        provider: 'antigravity-compatible',
        headers,
        model: request.model,
        repeats,
        signal: request.signal,
      })
    );
  }
  const headers = antigravityV1BetaHeaders(request.apiKey, authMode);
  return runCalibratedContextWindowCheck(request.contextWindow, repeats =>
    sendGeminiV1BetaContextProbe({
      v1betaBaseUrl: urls.v1betaBaseUrl,
      provider: 'antigravity-compatible',
      headers,
      model: request.model,
      repeats,
      signal: request.signal,
    })
  );
}

export async function probeAntigravityCompatibleModelThinking(request: {
  baseUrl: string;
  apiKey: string;
  wireProtocol?: AntigravityCompatibleWireProtocol;
  authMode?: AntigravityCompatibleAuthMode;
  model: string;
  signal?: AbortSignal;
}): Promise<CompatibleThinkingProbeResult> {
  const urls = resolveAntigravityCompatibleUrls(request.baseUrl);
  const authMode = request.authMode ?? 'both';
  const wire = resolveAntigravityModelWire(request.model, request.wireProtocol ?? 'auto');
  if (wire === 'anthropic') {
    return probeAnthropicMessagesThinking({
      messagesUrl: urls.messagesUrl,
      headers: antigravityMessagesHeaders(request.apiKey, authMode),
      provider: 'antigravity-compatible',
      model: request.model,
      signal: request.signal,
    });
  }
  return probeGeminiV1BetaThinking({
    v1betaBaseUrl: urls.v1betaBaseUrl,
    headers: antigravityV1BetaHeaders(request.apiKey, authMode),
    provider: 'antigravity-compatible',
    model: request.model,
    signal: request.signal,
  });
}
