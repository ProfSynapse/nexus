import { createParser } from 'eventsource-parser';
import type {
  LLMProviderConfig,
  OpenAICompatibleModelDefinition,
  ResponsesCompatibleAuthMode,
  ResponsesCompatibleStateMode,
} from '../../../../types/llm/ProviderTypes';
import type { ModelInfo } from '../types';
import { ANTHROPIC_MODELS } from '../anthropic/AnthropicModels';
import { GOOGLE_MODELS } from '../google/GoogleModels';
import { OPENAI_MODELS } from '../openai/OpenAIModels';
import { parseDiscoveredModelEntries } from '../anthropic-compatible/AnthropicCompatibleConfig';
import {
  isOpenAICompatibleContextWindow,
  isOpenAICompatibleModelId,
  OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS,
  type DiscoveredOpenAICompatibleModel,
  type OpenAICompatibleContextSource,
} from '../openai-compatible/OpenAICompatibleConfig';
import type { OpenAICompatibleContextCheckResult } from '../openai-compatible/OpenAICompatibleContextCheck';
import { ProviderHttpClient, type ProviderHttpResponse } from '../shared/ProviderHttpClient';
import { resolveDefinitionThinking, stripCompatibleModelPrefix } from '../shared/CompatibleEndpointUtils';
import {
  probeResponsesCompatibleThinking,
  type CompatibleThinkingProbeResult,
} from '../shared/CompatibleThinkingProbe';
import {
  COMPATIBLE_CONTEXT_FILLER,
  runCalibratedContextWindowCheck,
  type CompatibleContextProbeAttempt,
} from '../shared/CompatibleContextCheck';
import { extractResponsesApiStreamError } from '../../streaming/streamErrorFrames';
import { TokenUsageExtractor } from '../../utils/TokenUsageExtractor';

export const RESPONSES_COMPATIBLE_CONTEXT_WINDOW = 200_000;
export const RESPONSES_COMPATIBLE_MAX_OUTPUT_TOKENS = 16_384;

export interface ResolvedResponsesCompatibleUrls {
  baseUrl: string;
  apiBaseUrl: string;
  responsesUrl: string;
  modelsUrls: string[];
}

function findKnownModelDefaults(modelId: string): { contextWindow?: number; maxTokens?: number } {
  const bare = stripCompatibleModelPrefix(modelId);
  const openAIMatch = OPENAI_MODELS.find(model => model.apiName === bare);
  if (openAIMatch) {
    return { contextWindow: openAIMatch.contextWindow, maxTokens: openAIMatch.maxTokens };
  }
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

export function resolveResponsesCompatibleContextWindow(
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
    contextWindow: isOpenAICompatibleContextWindow(known) ? known : RESPONSES_COMPATIBLE_CONTEXT_WINDOW,
    source: 'default',
  };
}

export function buildResponsesCompatibleModels(config: LLMProviderConfig): ModelInfo[] {
  const definitions = config.responsesCompatible?.models ?? {};
  return Object.keys(definitions)
    .filter(id => isOpenAICompatibleModelId(id) && config.models?.[id]?.enabled !== false)
    .map(id => {
      const defaults = findKnownModelDefaults(id);
      return {
        id,
        name: id,
        contextWindow: resolveResponsesCompatibleContextWindow(definitions[id], id).contextWindow,
        maxOutputTokens: defaults.maxTokens ?? RESPONSES_COMPATIBLE_MAX_OUTPUT_TOKENS,
        supportsStreaming: true,
        supportsFunctions: true,
        supportsThinking: resolveDefinitionThinking(definitions[id]).supportsThinking ?? true,
        supportsImages: true,
        supportsJSON: true,
        pricing: null,
      };
    });
}

export function normalizeResponsesCompatibleBaseUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS for remote endpoints; HTTP is allowed only for localhost.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Enter an API base URL without credentials, query parameters, or a fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (/\/(?:responses|chat\/completions|completions|messages|models)$/i.test(url.pathname)) {
    throw new Error('Enter the API base URL, not a responses or models URL.');
  }
  return url.href.replace(/\/+$/, '');
}

export function resolveResponsesCompatibleUrls(baseUrl: string): ResolvedResponsesCompatibleUrls {
  const normalized = normalizeResponsesCompatibleBaseUrl(baseUrl);
  const parsed = new URL(normalized);
  const endsWithV1 = /\/v1$/i.test(parsed.pathname);
  const endsWithCodex = /\/codex$/i.test(parsed.pathname);
  if (endsWithV1 || endsWithCodex) {
    const apiBaseUrl = normalized;
    const responsesUrl = `${apiBaseUrl}/responses`;
    const modelsUrls = endsWithV1
      ? [`${apiBaseUrl}/models`]
      : [`${apiBaseUrl}/models`, `${normalized.replace(/\/codex$/i, '')}/v1/models`];
    return { baseUrl: normalized, apiBaseUrl, responsesUrl, modelsUrls };
  }
  const apiBaseUrl = `${normalized}/v1`;
  const responsesUrl = `${apiBaseUrl}/responses`;
  const modelsUrls = [`${apiBaseUrl}/models`, `${normalized}/models`];
  return { baseUrl: normalized, apiBaseUrl, responsesUrl, modelsUrls };
}

export function responsesCompatibleHeaders(
  apiKey: string,
  authMode: ResponsesCompatibleAuthMode = 'bearer',
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const key = apiKey.trim();
  if (key) {
    if (authMode === 'bearer' || authMode === 'both') {
      headers.Authorization = `Bearer ${key}`;
    }
    if (authMode === 'x-api-key' || authMode === 'both') {
      headers['x-api-key'] = key;
    }
  }
  return headers;
}

export function validateResponsesCompatibleConfig(config: LLMProviderConfig): ResolvedResponsesCompatibleUrls {
  const endpoint = config.responsesCompatible;
  if (!endpoint || endpoint.schemaVersion !== 1 || typeof endpoint.displayName !== 'string'
    || !endpoint.displayName.trim() || !endpoint.models || typeof endpoint.models !== 'object'
    || Array.isArray(endpoint.models)) {
    throw new Error('Responses-compatible endpoint settings are incomplete.');
  }
  for (const [id, definition] of Object.entries(endpoint.models)) {
    if (!isOpenAICompatibleModelId(id)
      || !definition || !['manual', 'discovered'].includes(definition.source)) {
      throw new Error('Responses-compatible model definitions are invalid.');
    }
  }
  return resolveResponsesCompatibleUrls(endpoint.baseUrl);
}

export async function discoverResponsesCompatibleModels(
  baseUrl: string,
  apiKey: string,
  authMode: ResponsesCompatibleAuthMode = 'bearer',
): Promise<DiscoveredOpenAICompatibleModel[]> {
  const { modelsUrls } = resolveResponsesCompatibleUrls(baseUrl);
  const headers = responsesCompatibleHeaders(apiKey, authMode);
  let lastResponseError: ProviderHttpResponse<unknown> | undefined;

  for (let index = 0; index < modelsUrls.length; index++) {
    const response = await ProviderHttpClient.request<unknown>({
      url: modelsUrls[index],
      provider: 'responses-compatible',
      operation: 'model discovery',
      method: 'GET',
      headers,
      timeoutMs: 30_000,
      retries: 0,
    });
    if (!response.ok) {
      if (response.status === 404 && index < modelsUrls.length - 1) {
        lastResponseError = response;
        continue;
      }
      ProviderHttpClient.assertOk(response, `Model discovery failed: HTTP ${response.status}`);
    }
    const parsed = parseDiscoveredModelEntries(response.json);
    if (!parsed) {
      if (index < modelsUrls.length - 1) {
        continue;
      }
      throw new Error('Model discovery did not return a models list. Add a model ID manually.');
    }
    return parsed;
  }

  if (lastResponseError) {
    ProviderHttpClient.assertOk(lastResponseError, 'Model discovery failed');
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function extractResponsesErrorDetail(json: unknown, text: string): string {
  const body = asRecord(json);
  if (body) {
    const errorValue = body.error;
    if (typeof errorValue === 'string' && errorValue.trim()) {
      return errorValue.trim();
    }
    const errorRecord = asRecord(errorValue);
    if (typeof errorRecord?.message === 'string' && errorRecord.message.trim()) {
      return errorRecord.message.trim();
    }
    if (typeof body.message === 'string' && body.message.trim()) {
      return body.message.trim();
    }
    const detailValue = body.detail;
    if (typeof detailValue === 'string' && detailValue.trim()) {
      return detailValue.trim();
    }
    const detailRecord = asRecord(detailValue);
    if (typeof detailRecord?.message === 'string' && detailRecord.message.trim()) {
      return detailRecord.message.trim();
    }
  }
  return text.trim().slice(0, 500);
}

function hasEventStreamHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-type' && typeof value === 'string' && /text\/event-stream/i.test(value)) {
      return true;
    }
  }
  return false;
}

function parseResponsesSseProbe(sseText: string, status: number): CompatibleContextProbeAttempt {
  let promptTokens: number | undefined;
  let streamError: string | undefined;
  let streamErrorJson: unknown = null;

  const parser = createParser((sseEvent) => {
    if (sseEvent.type === 'reconnect-interval' || streamError) return;
    if (sseEvent.data === '[DONE]') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(sseEvent.data);
    } catch {
      if (sseEvent.event === 'error' && sseEvent.data.trim()) {
        streamError = sseEvent.data.trim();
      }
      return;
    }

    const errorMessage = extractResponsesApiStreamError(parsed, 'Responses context check error');
    if (errorMessage) {
      streamError = errorMessage;
      streamErrorJson = parsed;
      return;
    }

    const frame = asRecord(parsed);
    if (!frame) return;
    const eventType = typeof frame.type === 'string' ? frame.type : '';
    if (eventType === 'response.completed' || eventType === 'response.done' || eventType === 'response.incomplete') {
      const resp = asRecord(frame.response);
      const normalized = TokenUsageExtractor.normalize(resp?.usage ?? frame.usage);
      if (typeof normalized?.promptTokens === 'number' && normalized.promptTokens > 0) {
        promptTokens = normalized.promptTokens;
      }
    }
  });

  parser.feed(sseText.endsWith('\n\n') ? sseText : `${sseText}\n\n`);

  if (streamError) {
    return {
      ok: false,
      status,
      json: streamErrorJson,
      detail: streamError,
    };
  }

  return {
    ok: true,
    status,
    json: null,
    promptTokens,
    detail: '',
  };
}

export async function checkResponsesCompatibleContextWindow(request: {
  baseUrl: string;
  apiKey: string;
  stateMode?: ResponsesCompatibleStateMode;
  authMode?: ResponsesCompatibleAuthMode;
  model: string;
  contextWindow: number;
  signal?: AbortSignal;
}): Promise<OpenAICompatibleContextCheckResult> {
  const { responsesUrl } = resolveResponsesCompatibleUrls(request.baseUrl);
  const headers = responsesCompatibleHeaders(request.apiKey, request.authMode ?? 'bearer');
  const stateMode: ResponsesCompatibleStateMode = request.stateMode ?? 'stateless';
  let requireStream = false;

  const sendProbe = async (repeats: number, forceStream?: boolean): Promise<CompatibleContextProbeAttempt> => {
    const stream = forceStream ?? requireStream;
    const filler = COMPATIBLE_CONTEXT_FILLER.repeat(repeats);
    const body: Record<string, unknown> = {
      model: request.model,
      instructions: '',
      input: [{ role: 'user', content: filler }],
      max_output_tokens: 16,
      stream,
      ...(stateMode === 'stateless' ? { store: false } : {}),
    };

    const response = await ProviderHttpClient.request<unknown>({
      url: responsesUrl,
      provider: 'responses-compatible',
      operation: 'context check',
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeoutMs: OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS,
      signal: request.signal,
      retries: 0,
    });

    if (!response.ok) {
      const detail = extractResponsesErrorDetail(response.json, response.text);
      if (!stream && response.status === 400 && (/stream/i.test(detail) || /stream/i.test(response.text))) {
        requireStream = true;
        return await sendProbe(repeats, true);
      }
      return {
        ok: false,
        status: response.status,
        json: response.json,
        detail,
      };
    }

    if (hasEventStreamHeader(response.headers) || (!response.json && /^\s*(?:event:|data:)/m.test(response.text))) {
      requireStream = true;
      return parseResponsesSseProbe(response.text, response.status);
    }

    const jsonError = extractResponsesApiStreamError(response.json, 'Responses context check error');
    if (jsonError) {
      return {
        ok: false,
        status: response.status,
        json: response.json,
        detail: jsonError,
      };
    }

    const responseObj = asRecord(response.json);
    const nestedResp = asRecord(responseObj?.response);
    const promptTokens = TokenUsageExtractor.normalize(responseObj?.usage ?? nestedResp?.usage)?.promptTokens;
    return {
      ok: true,
      status: response.status,
      json: response.json,
      promptTokens: typeof promptTokens === 'number' && promptTokens > 0 ? promptTokens : undefined,
      detail: '',
    };
  };

  return await runCalibratedContextWindowCheck(request.contextWindow, repeats => sendProbe(repeats));
}

export async function probeResponsesCompatibleModelThinking(request: {
  baseUrl: string;
  apiKey: string;
  stateMode?: ResponsesCompatibleStateMode;
  authMode?: ResponsesCompatibleAuthMode;
  model: string;
  signal?: AbortSignal;
}): Promise<CompatibleThinkingProbeResult> {
  const { responsesUrl } = resolveResponsesCompatibleUrls(request.baseUrl);
  const headers = responsesCompatibleHeaders(request.apiKey, request.authMode ?? 'bearer');
  return probeResponsesCompatibleThinking({
    responsesUrl,
    headers,
    stateless: (request.stateMode ?? 'stateless') === 'stateless',
    model: request.model,
    signal: request.signal,
  });
}
