import type { LLMProviderConfig } from '../../../../types/llm/ProviderTypes';
import { getContextWindowOverrideKey } from '../../../../ui/chat/utils/ContextWindowSettings';
import type { ModelInfo } from '../types';
import {
  buildOpenAICompatibleModels,
  OPENAI_COMPATIBLE_CONTEXT_WINDOW,
  resolveOpenAICompatibleContextWindow,
  type ContextOverrideRelease,
} from '../openai-compatible/OpenAICompatibleConfig';
import {
  ANTHROPIC_COMPATIBLE_CONTEXT_WINDOW,
  buildAnthropicCompatibleModels,
  resolveAnthropicCompatibleContextWindow,
} from '../anthropic-compatible/AnthropicCompatibleConfig';
import {
  ANTIGRAVITY_COMPATIBLE_CONTEXT_WINDOW,
  buildAntigravityCompatibleModels,
  resolveAntigravityCompatibleContextWindow,
} from '../antigravity-compatible/AntigravityCompatibleConfig';
import {
  buildResponsesCompatibleModels,
  resolveResponsesCompatibleContextWindow,
  RESPONSES_COMPATIBLE_CONTEXT_WINDOW,
} from '../responses-compatible/ResponsesCompatibleConfig';
import { getCustomCompatibleModelsRecord } from './CompatibleEndpointUtils';

export function buildCustomCompatibleModels(config: LLMProviderConfig): ModelInfo[] {
  switch (config.driverKind) {
    case 'anthropic-compatible':
      return buildAnthropicCompatibleModels(config);
    case 'antigravity-compatible':
      return buildAntigravityCompatibleModels(config);
    case 'openai-compatible':
      return buildOpenAICompatibleModels(config);
    case 'responses-compatible':
      return buildResponsesCompatibleModels(config);
    default:
      return [];
  }
}

export function getDefaultCustomCompatibleContextWindow(
  config?: LLMProviderConfig | null,
  modelId?: string,
): number {
  switch (config?.driverKind) {
    case 'anthropic-compatible':
      return resolveAnthropicCompatibleContextWindow(undefined, modelId).contextWindow || ANTHROPIC_COMPATIBLE_CONTEXT_WINDOW;
    case 'antigravity-compatible':
      return resolveAntigravityCompatibleContextWindow(undefined, modelId).contextWindow || ANTIGRAVITY_COMPATIBLE_CONTEXT_WINDOW;
    case 'openai-compatible':
      return OPENAI_COMPATIBLE_CONTEXT_WINDOW;
    case 'responses-compatible':
      return resolveResponsesCompatibleContextWindow(undefined, modelId).contextWindow || RESPONSES_COMPATIBLE_CONTEXT_WINDOW;
    default:
      return 128_000;
  }
}

function resolveModelContextByDriver(
  config: LLMProviderConfig,
  modelId: string,
): number {
  const definitions = getCustomCompatibleModelsRecord(config);
  const definition = definitions[modelId];
  switch (config.driverKind) {
    case 'anthropic-compatible':
      return resolveAnthropicCompatibleContextWindow(definition, modelId).contextWindow;
    case 'antigravity-compatible':
      return resolveAntigravityCompatibleContextWindow(definition, modelId).contextWindow;
    case 'responses-compatible':
      return resolveResponsesCompatibleContextWindow(definition, modelId).contextWindow;
    default:
      return resolveOpenAICompatibleContextWindow(definition).contextWindow;
  }
}

export function releaseRaisedCustomCompatibleContextOverrides(
  providerId: string,
  previous: LLMProviderConfig | undefined,
  next: LLMProviderConfig,
  overrideMaps: Array<Record<string, number> | undefined>,
): ContextOverrideRelease[] {
  const released: ContextOverrideRelease[] = [];
  if (!previous) return released;
  const before = getCustomCompatibleModelsRecord(previous);
  const after = getCustomCompatibleModelsRecord(next);
  for (const model of Object.keys(after)) {
    if (!Object.prototype.hasOwnProperty.call(before, model)) continue;
    const oldMaximum = resolveModelContextByDriver(previous, model);
    const newMaximum = resolveModelContextByDriver(next, model);
    if (newMaximum <= oldMaximum) continue;
    const key = getContextWindowOverrideKey(providerId, model);
    for (const map of overrideMaps) {
      if (map?.[key] !== oldMaximum) continue;
      released.push({ map, key, value: oldMaximum });
      delete map[key];
    }
  }
  return released;
}
