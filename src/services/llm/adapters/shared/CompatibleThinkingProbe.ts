import type {
  CompatibleThinkingMode,
  OpenAICompatibleModelDefinition,
  ThinkingEffort,
} from '../../../../types/llm/ProviderTypes';
import {
  CANONICAL_THINKING_EFFORTS,
  normalizeThinkingEffortList,
  resolveDefinitionThinking,
} from './CompatibleEndpointUtils';
import { ProviderHttpClient } from './ProviderHttpClient';
import { extractResponsesApiStreamError } from '../../streaming/streamErrorFrames';

export interface DiscoveredThinkingMetadata {
  supportsThinking?: boolean;
  thinkingEfforts?: ThinkingEffort[];
}

export type CompatibleThinkingProbeResult =
  | { kind: 'supported'; efforts: ThinkingEffort[]; mode: CompatibleThinkingMode }
  | { kind: 'unsupported'; reason?: string }
  | { kind: 'failed'; message: string };

const SENTINEL_EFFORT = '__nexus_probe_invalid__';
const PROBE_TIMEOUT_MS = 45_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readErrorText(json: unknown, text: string): string {
  const root = asRecord(json);
  const err = root?.error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  const errObj = asRecord(err);
  if (typeof errObj?.message === 'string' && errObj.message.trim()) return errObj.message.trim();
  if (typeof root?.message === 'string' && root.message.trim()) return root.message.trim();
  return text.trim().slice(0, 240);
}

function isClientValidationStatus(status: number): boolean {
  return status === 400 || status === 422;
}

/**
 * Extract thinking support and distinct effort tiers from `/models`, `/v1beta/models`,
 * or `/model/info` entries. Returns `{}` when no thinking metadata is present.
 */
export function readReportedThinkingMetadata(entry: unknown): DiscoveredThinkingMetadata {
  const item = asRecord(entry);
  if (!item) return {};
  const meta = asRecord(item.metadata);
  const modelInfo = asRecord(item.model_info);
  const capabilities = asRecord(item.capabilities);
  const thinkingObj = asRecord(item.thinking) ?? asRecord(meta?.thinking);
  const reasoningObj = asRecord(item.reasoning) ?? asRecord(meta?.reasoning);

  const effortSources: unknown[] = [
    item.supported_reasoning_levels,
    meta?.supported_reasoning_levels,
    modelInfo?.supported_reasoning_levels,
    thinkingObj?.levels,
    thinkingObj?.efforts,
    reasoningObj?.levels,
    reasoningObj?.efforts,
    item.thinking_levels,
    item.reasoning_efforts,
    item.supported_thinking_efforts,
    asRecord(item.reasoning_effort_map) ? Object.keys(item.reasoning_effort_map as object) : undefined,
  ];

  let thinkingEfforts: ThinkingEffort[] | undefined;
  for (const candidate of effortSources) {
    const parsed = normalizeThinkingEffortList(candidate);
    if (parsed && parsed.length > 0) {
      thinkingEfforts = parsed;
      break;
    }
  }

  let supportsThinking: boolean | undefined;
  const boolCandidates: unknown[] = [
    typeof item.reasoning === 'boolean' ? item.reasoning : undefined,
    typeof meta?.reasoning === 'boolean' ? meta.reasoning : undefined,
    typeof item.thinking === 'boolean' ? item.thinking : undefined,
    typeof meta?.thinking === 'boolean' ? meta.thinking : undefined,
    typeof item.supports_reasoning === 'boolean' ? item.supports_reasoning : undefined,
    typeof item.supports_thinking === 'boolean' ? item.supports_thinking : undefined,
    typeof modelInfo?.supports_reasoning === 'boolean' ? modelInfo.supports_reasoning : undefined,
    typeof capabilities?.supportsThinking === 'boolean' ? capabilities.supportsThinking : undefined,
    typeof capabilities?.reasoning === 'boolean' ? capabilities.reasoning : undefined,
    typeof capabilities?.thinking === 'boolean' ? capabilities.thinking : undefined,
    typeof thinkingObj?.supported === 'boolean' ? thinkingObj.supported : undefined,
    typeof reasoningObj?.supported === 'boolean' ? reasoningObj.supported : undefined,
  ];
  for (const flag of boolCandidates) {
    if (typeof flag === 'boolean') {
      supportsThinking = flag;
      break;
    }
  }

  if (supportsThinking === undefined) {
    const paramArrays = [item.supported_parameters, item.supported_openai_params, modelInfo?.supported_openai_params];
    for (const arr of paramArrays) {
      if (!Array.isArray(arr)) continue;
      if (arr.some(p => typeof p === 'string' && /^(?:reasoning|reasoning_effort|thinking|include_reasoning)$/i.test(p.trim()))) {
        supportsThinking = true;
        break;
      }
    }
  }

  if (thinkingEfforts && thinkingEfforts.length > 0 && supportsThinking === undefined) {
    supportsThinking = true;
  }
  if (supportsThinking === false) {
    return { supportsThinking: false };
  }

  const out: DiscoveredThinkingMetadata = {};
  if (supportsThinking !== undefined) out.supportsThinking = supportsThinking;
  if (thinkingEfforts && thinkingEfforts.length > 0) out.thinkingEfforts = thinkingEfforts;
  return out;
}

export function describeThinkingCapability(
  definition: OpenAICompatibleModelDefinition | undefined,
): string | null {
  const resolved = resolveDefinitionThinking(definition);
  if (resolved.source === 'default') return null;
  const origin = resolved.source === 'probed' ? 'probed' : 'server reported';
  if (resolved.supportsThinking === false) {
    return `Thinking: not supported (${origin}).`;
  }
  if (resolved.efforts && resolved.efforts.length > 0) {
    return `Thinking tiers: ${resolved.efforts.join(', ')} (${origin}).`;
  }
  return `Thinking: supported (${origin}).`;
}

function chatCompletionHasReasoning(json: unknown): boolean {
  const root = asRecord(json);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const first = asRecord(choices[0]);
  const msg = asRecord(first?.message);
  if (typeof msg?.reasoning_content === 'string' && msg.reasoning_content.trim().length > 0) return true;
  if (typeof msg?.reasoning === 'string' && msg.reasoning.trim().length > 0) return true;
  if (typeof msg?.content === 'string' && /^\s*<think>/i.test(msg.content)) return true;
  const usage = asRecord(root?.usage);
  const details = asRecord(usage?.completion_tokens_details) ?? asRecord(usage?.output_tokens_details);
  return typeof details?.reasoning_tokens === 'number' && details.reasoning_tokens > 0;
}

export async function probeOpenAICompatibleThinking(params: {
  chatCompletionsUrl: string;
  headers: Record<string, string>;
  model: string;
  signal?: AbortSignal;
}): Promise<CompatibleThinkingProbeResult> {
  const send = (effort?: string) => ProviderHttpClient.request<unknown>({
    url: params.chatCompletionsUrl,
    provider: 'openai-compatible',
    operation: 'thinking probe',
    method: 'POST',
    headers: params.headers,
    body: JSON.stringify({
      model: params.model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 16,
      stream: false,
      ...(effort !== undefined ? { reasoning_effort: effort } : {}),
    }),
    timeoutMs: PROBE_TIMEOUT_MS,
    signal: params.signal,
    retries: 0,
  });

  const sentinel = await send(SENTINEL_EFFORT);
  if (!sentinel.ok && !isClientValidationStatus(sentinel.status)) {
    return { kind: 'failed', message: `HTTP ${sentinel.status}: ${readErrorText(sentinel.json, sentinel.text)}` };
  }

  if (sentinel.ok) {
    // Permissive endpoint ignored invalid reasoning_effort; check if native reasoning was emitted anyway.
    if (chatCompletionHasReasoning(sentinel.json)) {
      return { kind: 'supported', efforts: ['medium'], mode: 'effort' };
    }
    return { kind: 'unsupported', reason: 'Endpoint ignored reasoning_effort and emitted no reasoning.' };
  }

  const results = await Promise.all(
    CANONICAL_THINKING_EFFORTS.map(async effort => {
      const res = await send(effort);
      return res.ok ? effort : null;
    })
  );
  const accepted = results.filter((item): item is ThinkingEffort => item !== null);
  if (accepted.length > 0) {
    return { kind: 'supported', efforts: accepted, mode: 'effort' };
  }
  return { kind: 'unsupported', reason: readErrorText(sentinel.json, sentinel.text) };
}

function responsesPayloadHasReasoning(json: unknown, sseText?: string): boolean {
  if (sseText) {
    if (/response\.reasoning_(?:summary_)?text\.delta|"type"\s*:\s*"reasoning"|"reasoning_tokens"\s*:\s*[1-9]/.test(sseText)) {
      return true;
    }
  }
  const root = asRecord(json);
  const output = Array.isArray(root?.output) ? root.output : [];
  if (output.some(item => asRecord(item)?.type === 'reasoning')) return true;
  const usage = asRecord(root?.usage);
  const details = asRecord(usage?.output_tokens_details);
  return typeof details?.reasoning_tokens === 'number' && details.reasoning_tokens > 0;
}

function sseContainsResponsesError(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const err = extractResponsesApiStreamError(parsed, 'Responses probe error');
      if (err) return err;
    } catch {
      // Ignore partial non-JSON lines.
    }
  }
  return null;
}

export async function probeResponsesCompatibleThinking(params: {
  responsesUrl: string;
  headers: Record<string, string>;
  stateless: boolean;
  model: string;
  signal?: AbortSignal;
}): Promise<CompatibleThinkingProbeResult> {
  const send = async (effort: string): Promise<{ ok: boolean; status: number; detail: string; hasReasoning: boolean }> => {
    const buildBody = (stream: boolean) => JSON.stringify({
      model: params.model,
      input: [{ role: 'user', content: 'Reply with OK.' }],
      instructions: '',
      max_output_tokens: 16,
      stream,
      ...(params.stateless ? { store: false } : {}),
      reasoning: { effort, summary: 'auto' },
    });

    let res = await ProviderHttpClient.request<unknown>({
      url: params.responsesUrl,
      provider: 'responses-compatible',
      operation: 'thinking probe',
      method: 'POST',
      headers: params.headers,
      body: buildBody(false),
      timeoutMs: PROBE_TIMEOUT_MS,
      signal: params.signal,
      retries: 0,
    });

    const firstDetail = readErrorText(res.json, res.text);
    if (!res.ok && res.status === 400 && /\bstream\b/i.test(firstDetail)) {
      res = await ProviderHttpClient.request<unknown>({
        url: params.responsesUrl,
        provider: 'responses-compatible',
        operation: 'thinking probe',
        method: 'POST',
        headers: params.headers,
        body: buildBody(true),
        timeoutMs: PROBE_TIMEOUT_MS,
        signal: params.signal,
        retries: 0,
      });
    }

    if (!res.ok) {
      return { ok: false, status: res.status, detail: readErrorText(res.json, res.text), hasReasoning: false };
    }
    const contentType = res.headers['content-type'] ?? res.headers['Content-Type'] ?? '';
    const looksLikeSse = /text\/event-stream/i.test(contentType) || /^\s*(?:event:|data:)/m.test(res.text);
    if (looksLikeSse) {
      const sseErr = sseContainsResponsesError(res.text);
      if (sseErr) {
        return { ok: false, status: 400, detail: sseErr, hasReasoning: false };
      }
      return { ok: true, status: 200, detail: '', hasReasoning: responsesPayloadHasReasoning(undefined, res.text) };
    }
    return { ok: true, status: 200, detail: '', hasReasoning: responsesPayloadHasReasoning(res.json) };
  };

  const sentinel = await send(SENTINEL_EFFORT);
  if (!sentinel.ok && !isClientValidationStatus(sentinel.status)) {
    return { kind: 'failed', message: `HTTP ${sentinel.status}: ${sentinel.detail}` };
  }
  if (sentinel.ok) {
    if (sentinel.hasReasoning) {
      return { kind: 'supported', efforts: ['medium'], mode: 'effort' };
    }
    return { kind: 'unsupported', reason: 'Endpoint ignored reasoning.effort and emitted no reasoning.' };
  }

  const results = await Promise.all(
    CANONICAL_THINKING_EFFORTS.map(async effort => {
      const res = await send(effort);
      return res.ok ? effort : null;
    })
  );
  const accepted = results.filter((item): item is ThinkingEffort => item !== null);
  if (accepted.length > 0) {
    return { kind: 'supported', efforts: accepted, mode: 'effort' };
  }
  return { kind: 'unsupported', reason: sentinel.detail };
}

export async function probeAnthropicMessagesThinking(params: {
  messagesUrl: string;
  headers: Record<string, string>;
  provider: string;
  model: string;
  signal?: AbortSignal;
}): Promise<CompatibleThinkingProbeResult> {
  const sendAdaptive = (effort: string) => ProviderHttpClient.request<unknown>({
    url: params.messagesUrl,
    provider: params.provider,
    operation: 'thinking probe',
    method: 'POST',
    headers: params.headers,
    body: JSON.stringify({
      model: params.model,
      max_tokens: 32,
      thinking: { type: 'adaptive' },
      output_config: { effort },
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    }),
    timeoutMs: PROBE_TIMEOUT_MS,
    signal: params.signal,
    retries: 0,
  });

  const highAdaptive = await sendAdaptive('high');
  if (!highAdaptive.ok && !isClientValidationStatus(highAdaptive.status)) {
    return { kind: 'failed', message: `HTTP ${highAdaptive.status}: ${readErrorText(highAdaptive.json, highAdaptive.text)}` };
  }

  if (highAdaptive.ok) {
    const [sentinel, ...rest] = await Promise.all([
      sendAdaptive(SENTINEL_EFFORT),
      ...(['low', 'medium', 'xhigh', 'max'] as const).map(async effort => ({
        effort,
        res: await sendAdaptive(effort),
      })),
    ]);
    if (sentinel.ok) {
      return { kind: 'supported', efforts: [...CANONICAL_THINKING_EFFORTS], mode: 'adaptive' };
    }
    const acceptedSet = new Set<ThinkingEffort>(['high']);
    for (const item of rest) {
      if (item.res.ok) acceptedSet.add(item.effort);
    }
    const ordered = CANONICAL_THINKING_EFFORTS.filter(level => acceptedSet.has(level));
    return { kind: 'supported', efforts: ordered, mode: 'adaptive' };
  }

  // Fallback: probe manual budget_tokens thinking (Claude 3.7 / 4.5 family and compatible gateways)
  const budgetProbe = await ProviderHttpClient.request<unknown>({
    url: params.messagesUrl,
    provider: params.provider,
    operation: 'thinking probe',
    method: 'POST',
    headers: params.headers,
    body: JSON.stringify({
      model: params.model,
      max_tokens: 1056,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    }),
    timeoutMs: PROBE_TIMEOUT_MS,
    signal: params.signal,
    retries: 0,
  });

  if (!budgetProbe.ok && !isClientValidationStatus(budgetProbe.status)) {
    return { kind: 'failed', message: `HTTP ${budgetProbe.status}: ${readErrorText(budgetProbe.json, budgetProbe.text)}` };
  }
  if (budgetProbe.ok) {
    return { kind: 'supported', efforts: [...CANONICAL_THINKING_EFFORTS], mode: 'budget' };
  }
  return { kind: 'unsupported', reason: readErrorText(budgetProbe.json, budgetProbe.text) };
}

export async function probeGeminiV1BetaThinking(params: {
  v1betaBaseUrl: string;
  headers: Record<string, string>;
  provider: string;
  model: string;
  signal?: AbortSignal;
}): Promise<CompatibleThinkingProbeResult> {
  const cleanedModel = params.model.replace(/^models\//i, '').split('/').map(encodeURIComponent).join('/');
  const url = `${params.v1betaBaseUrl.replace(/\/+$/, '')}/models/${cleanedModel}:generateContent`;

  const sendLevel = (level: string) => ProviderHttpClient.request<unknown>({
    url,
    provider: params.provider,
    operation: 'thinking probe',
    method: 'POST',
    headers: params.headers,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
      generationConfig: {
        maxOutputTokens: 32,
        thinkingConfig: { includeThoughts: true, thinkingLevel: level },
      },
    }),
    timeoutMs: PROBE_TIMEOUT_MS,
    signal: params.signal,
    retries: 0,
  });

  const highLevel = await sendLevel('high');
  if (!highLevel.ok && !isClientValidationStatus(highLevel.status)) {
    return { kind: 'failed', message: `HTTP ${highLevel.status}: ${readErrorText(highLevel.json, highLevel.text)}` };
  }

  if (highLevel.ok) {
    const geminiCandidateLevels: readonly ThinkingEffort[] = ['low', 'medium', 'xhigh', 'max'];
    const [sentinel, ...others] = await Promise.all([
      sendLevel(SENTINEL_EFFORT),
      ...geminiCandidateLevels.map(async effort => ({
        effort,
        res: await sendLevel(effort),
      })),
    ]);
    if (sentinel.ok) {
      return { kind: 'supported', efforts: ['low', 'medium', 'high'], mode: 'level' };
    }
    const acceptedSet = new Set<ThinkingEffort>(['high']);
    for (const item of others) {
      if (item.res.ok) acceptedSet.add(item.effort);
    }
    const ordered = CANONICAL_THINKING_EFFORTS.filter(level => acceptedSet.has(level));
    return { kind: 'supported', efforts: ordered, mode: 'level' };
  }

  // Fallback: probe legacy Gemini 2.5 thinkingBudget
  const budgetProbe = await ProviderHttpClient.request<unknown>({
    url,
    provider: params.provider,
    operation: 'thinking probe',
    method: 'POST',
    headers: params.headers,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
      generationConfig: {
        maxOutputTokens: 1056,
        thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
      },
    }),
    timeoutMs: PROBE_TIMEOUT_MS,
    signal: params.signal,
    retries: 0,
  });

  if (!budgetProbe.ok && !isClientValidationStatus(budgetProbe.status)) {
    return { kind: 'failed', message: `HTTP ${budgetProbe.status}: ${readErrorText(budgetProbe.json, budgetProbe.text)}` };
  }
  if (budgetProbe.ok) {
    return { kind: 'supported', efforts: ['low', 'medium', 'high'], mode: 'budget' };
  }
  return { kind: 'unsupported', reason: readErrorText(budgetProbe.json, budgetProbe.text) };
}
