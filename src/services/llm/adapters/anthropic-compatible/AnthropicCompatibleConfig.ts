import type {
  AnthropicCompatibleAuthMode,
  LLMProviderConfig,
  OpenAICompatibleModelDefinition,
} from '../../../../types/llm/ProviderTypes';
import type { ModelInfo } from '../types';
import { ANTHROPIC_MODELS } from '../anthropic/AnthropicModels';
import { GOOGLE_MODELS } from '../google/GoogleModels';
import {
  isOpenAICompatibleContextWindow,
  isOpenAICompatibleModelId,
  readReportedContextWindow,
  type DiscoveredOpenAICompatibleModel,
  type OpenAICompatibleContextSource,
} from '../openai-compatible/OpenAICompatibleConfig';
import type { OpenAICompatibleContextCheckResult } from '../openai-compatible/OpenAICompatibleContextCheck';
import { ProviderHttpClient } from '../shared/ProviderHttpClient';
import { resolveDefinitionThinking, stripCompatibleModelPrefix } from '../shared/CompatibleEndpointUtils';
import {
  probeAnthropicMessagesThinking,
  readReportedThinkingMetadata,
  type CompatibleThinkingProbeResult,
} from '../shared/CompatibleThinkingProbe';
import {
  runCalibratedContextWindowCheck,
  sendAnthropicMessagesContextProbe,
} from '../shared/CompatibleContextCheck';

export const ANTHROPIC_COMPATIBLE_CONTEXT_WINDOW = 200_000;
export const ANTHROPIC_COMPATIBLE_MAX_OUTPUT_TOKENS = 16_384;

function findKnownModelDefaults(modelId: string): { contextWindow?: number; maxTokens?: number } {
  const bare = stripCompatibleModelPrefix(modelId);
  const anthropicMatch = ANTHROPIC_MODELS.find(model => model.apiName === bare);
  if (anthropicMatch) {
    const wants1m = modelId.endsWith(':1m');
    const variant = wants1m
      ? ANTHROPIC_MODELS.find(model => model.apiName === bare && model.contextWindow >= 1_000_000) ?? anthropicMatch
      : anthropicMatch;
    return { contextWindow: variant.contextWindow, maxTokens: variant.maxTokens };
  }
  const googleMatch = GOOGLE_MODELS.find(model => model.apiName === bare);
  if (googleMatch) {
    return { contextWindow: googleMatch.contextWindow, maxTokens: googleMatch.maxTokens };
  }
  return {};
}

export function resolveAnthropicCompatibleContextWindow(
  definition: OpenAICompatibleModelDefinition | undefined,
  modelId?: string,
): { contextWindow: number; source: OpenAICompatibleContextSource } {
  if (isOpenAICompatibleContextWindow(definition?.contextWindow)) {
    return { contextWindow: definition.contextWindow, source: 'user' };
  }
  if (isOpenAICompatibleContextWindow(definition?.reportedContextWindow)) {
    return { contextWindow: definition.reportedContextWindow, source: 'server' };
  }
  const known = modelId ? findKnownModelDefaults(modelId).contextWindow : undefined;
  return {
    contextWindow: isOpenAICompatibleContextWindow(known) ? known : ANTHROPIC_COMPATIBLE_CONTEXT_WINDOW,
    source: 'default',
  };
}

export function buildAnthropicCompatibleModels(config: LLMProviderConfig): ModelInfo[] {
  const definitions = config.anthropicCompatible?.models ?? {};
  return Object.keys(definitions)
    .filter(id => isOpenAICompatibleModelId(id) && config.models?.[id]?.enabled !== false)
    .map(id => {
      const defaults = findKnownModelDefaults(id);
      return {
        id,
        name: id,
        contextWindow: resolveAnthropicCompatibleContextWindow(definitions[id], id).contextWindow,
        maxOutputTokens: defaults.maxTokens ?? ANTHROPIC_COMPATIBLE_MAX_OUTPUT_TOKENS,
        supportsStreaming: true,
        supportsFunctions: true,
        supportsThinking: resolveDefinitionThinking(definitions[id]).supportsThinking ?? true,
        supportsImages: true,
        supportsJSON: true,
        pricing: null,
      };
    });
}

export function normalizeAnthropicCompatibleBaseUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS for remote endpoints; HTTP is allowed only for localhost.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Enter an API base URL without credentials, query parameters, or a fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (/\/(?:messages|chat\/completions|completions|models)$/i.test(url.pathname)) {
    throw new Error('Enter the API base URL, not a messages or models URL.');
  }
  return url.href.replace(/\/+$/, '');
}

export interface ResolvedAnthropicCompatibleUrls {
  baseUrl: string;
  v1BaseUrl: string;
  messagesUrl: string;
  modelsUrls: string[];
}

export function resolveAnthropicCompatibleUrls(baseUrl: string): ResolvedAnthropicCompatibleUrls {
  const normalized = normalizeAnthropicCompatibleBaseUrl(baseUrl);
  const parsed = new URL(normalized);
  const endsWithV1 = /\/v1$/i.test(parsed.pathname);
  const v1BaseUrl = endsWithV1 ? normalized : `${normalized}/v1`;
  const messagesUrl = `${v1BaseUrl}/messages`;
  const modelsUrls = endsWithV1
    ? [`${v1BaseUrl}/models`]
    : [`${v1BaseUrl}/models`, `${normalized}/models`];
  return { baseUrl: normalized, v1BaseUrl, messagesUrl, modelsUrls };
}

export function anthropicCompatibleHeaders(
  apiKey: string,
  authMode: AnthropicCompatibleAuthMode = 'x-api-key',
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  const key = apiKey.trim();
  if (key) {
    if (authMode === 'x-api-key' || authMode === 'both') {
      headers['x-api-key'] = key;
    }
    if (authMode === 'bearer' || authMode === 'both') {
      headers.Authorization = `Bearer ${key}`;
    }
  }
  return headers;
}

export function validateAnthropicCompatibleConfig(config: LLMProviderConfig): ResolvedAnthropicCompatibleUrls {
  const endpoint = config.anthropicCompatible;
  if (!endpoint || endpoint.schemaVersion !== 1 || typeof endpoint.displayName !== 'string'
    || !endpoint.displayName.trim() || !endpoint.models || typeof endpoint.models !== 'object'
    || Array.isArray(endpoint.models)) {
    throw new Error('Anthropic-compatible endpoint settings are incomplete.');
  }
  for (const [id, definition] of Object.entries(endpoint.models)) {
    if (!isOpenAICompatibleModelId(id)
      || !definition || !['manual', 'discovered'].includes(definition.source)) {
      throw new Error('Anthropic-compatible model definitions are invalid.');
    }
  }
  return resolveAnthropicCompatibleUrls(endpoint.baseUrl);
}

function readAnthropicReportedContextWindow(entry: unknown): number | undefined {
  const direct = readReportedContextWindow(entry);
  if (direct !== undefined) return direct;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const item = entry as Record<string, unknown>;
  for (const key of ['max_input_tokens', 'inputTokenLimit']) {
    const raw = item[key];
    const parsed = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
    if (isOpenAICompatibleContextWindow(parsed)) return parsed;
  }
  return undefined;
}

export function parseDiscoveredModelEntries(payload: unknown): DiscoveredOpenAICompatibleModel[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const list = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : null;
  if (!list) return null;

  const models = new Map<string, DiscoveredOpenAICompatibleModel>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (Array.isArray(item.supportedGenerationMethods)) {
      const methods = item.supportedGenerationMethods.filter((m): m is string => typeof m === 'string');
      if (methods.length > 0
        && !methods.includes('generateContent')
        && !methods.includes('streamGenerateContent')) {
        continue;
      }
    }
    const rawId = typeof item.id === 'string'
      ? item.id
      : typeof item.name === 'string'
        ? item.name.replace(/^models\//i, '')
        : undefined;
    if (!isOpenAICompatibleModelId(rawId) || models.has(rawId)) continue;
    const contextWindow = readAnthropicReportedContextWindow(item);
    const thinking = readReportedThinkingMetadata(item);
    const discovered: DiscoveredOpenAICompatibleModel = { id: rawId };
    if (contextWindow !== undefined) discovered.contextWindow = contextWindow;
    if (thinking.supportsThinking !== undefined) discovered.supportsThinking = thinking.supportsThinking;
    if (thinking.thinkingEfforts !== undefined) discovered.thinkingEfforts = thinking.thinkingEfforts;
    models.set(rawId, discovered);
  }
  return [...models.values()];
}

export async function discoverAnthropicCompatibleModels(
  baseUrl: string,
  apiKey: string,
  authMode: AnthropicCompatibleAuthMode = 'x-api-key',
): Promise<DiscoveredOpenAICompatibleModel[]> {
  const { modelsUrls } = resolveAnthropicCompatibleUrls(baseUrl);
  const headers = anthropicCompatibleHeaders(apiKey, authMode);
  let lastError: unknown;

  for (let index = 0; index < modelsUrls.length; index++) {
    const response = await ProviderHttpClient.request<unknown>({
      url: modelsUrls[index],
      provider: 'anthropic-compatible',
      operation: 'model discovery',
      method: 'GET',
      headers,
      timeoutMs: 30_000,
      retries: 0,
    });
    if (!response.ok) {
      if (response.status === 404 && index < modelsUrls.length - 1) {
        lastError = response;
        continue;
      }
      ProviderHttpClient.assertOk(response, `Model discovery failed: HTTP ${response.status}`);
    }
    const parsed = parseDiscoveredModelEntries(response.json);
    if (!parsed) {
      throw new Error('Model discovery did not return a models list. Add a model ID manually.');
    }
    return parsed;
  }

  if (lastError) {
    ProviderHttpClient.assertOk(lastError as Parameters<typeof ProviderHttpClient.assertOk>[0], 'Model discovery failed');
  }
  return [];
}

export async function checkAnthropicCompatibleContextWindow(request: {
  baseUrl: string;
  apiKey: string;
  authMode?: AnthropicCompatibleAuthMode;
  model: string;
  contextWindow: number;
  signal?: AbortSignal;
}): Promise<OpenAICompatibleContextCheckResult> {
  const { messagesUrl } = resolveAnthropicCompatibleUrls(request.baseUrl);
  const headers = anthropicCompatibleHeaders(request.apiKey, request.authMode ?? 'x-api-key');
  return runCalibratedContextWindowCheck(request.contextWindow, repeats =>
    sendAnthropicMessagesContextProbe({
      messagesUrl,
      provider: 'anthropic-compatible',
      headers,
      model: request.model,
      repeats,
      signal: request.signal,
    })
  );
}

export async function probeAnthropicCompatibleModelThinking(request: {
  baseUrl: string;
  apiKey: string;
  authMode?: AnthropicCompatibleAuthMode;
  model: string;
  signal?: AbortSignal;
}): Promise<CompatibleThinkingProbeResult> {
  const { messagesUrl } = resolveAnthropicCompatibleUrls(request.baseUrl);
  const headers = anthropicCompatibleHeaders(request.apiKey, request.authMode ?? 'x-api-key');
  return probeAnthropicMessagesThinking({
    messagesUrl,
    headers,
    provider: 'anthropic-compatible',
    model: request.model,
    signal: request.signal,
  });
}
