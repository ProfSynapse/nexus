/**
 * DeepSeek Model Specifications
 *
 * DeepSeek provides cost-efficient OpenAI-compatible models with very large
 * (1M token) context windows and a proprietary thinking-mode toggle.
 *
 * Thinking mode is enabled per-request via the
 * `thinking: { type: 'enabled', reasoning_effort }` body parameter; the API
 * surfaces reasoning text in `delta.reasoning_content` (streaming) or
 * `message.reasoning_content` (non-streaming). For UI/registry purposes we
 * expose a thinking variant for each base model so users can pick one or the
 * other from a single dropdown.
 */

import { ModelSpec } from '../modelTypes';

export const DEEPSEEK_MODELS: ModelSpec[] = [
  // Flash — cost-optimized, non-thinking default
  {
    provider: 'deepseek',
    name: 'DeepSeek V4 Flash',
    apiName: 'deepseek-v4-flash',
    contextWindow: 1_000_000,
    maxTokens: 65_536, // API supports up to 384K, capped here for safety with downstream buildLLMResponse
    inputCostPerMillion: 0.14,
    outputCostPerMillion: 0.28,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'deepseek',
    name: 'DeepSeek V4 Flash (Thinking)',
    apiName: 'deepseek-v4-flash-thinking',
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    inputCostPerMillion: 0.14,
    outputCostPerMillion: 0.28,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Pro — higher quality. Pricing reflects 75% promotional discount valid through 2026-05-31.
  // Original list price: $1.74 input / $3.48 output per 1M tokens.
  {
    provider: 'deepseek',
    name: 'DeepSeek V4 Pro',
    apiName: 'deepseek-v4-pro',
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    inputCostPerMillion: 0.435,
    outputCostPerMillion: 0.87,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'deepseek',
    name: 'DeepSeek V4 Pro (Thinking)',
    apiName: 'deepseek-v4-pro-thinking',
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    inputCostPerMillion: 0.435,
    outputCostPerMillion: 0.87,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  }
];

export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';

/**
 * Returns true if a DeepSeek model id maps to a thinking-capable variant.
 * Used by the adapter to decide whether to send the `thinking` request param
 * when the user has enabled thinking via settings or selected a *-thinking
 * model directly.
 */
export function isDeepSeekThinkingModel(modelId: string): boolean {
  return modelId.endsWith('-thinking');
}

/**
 * Resolve the underlying API model id. DeepSeek treats
 * `deepseek-v4-flash-thinking` as the same wire model as `deepseek-v4-flash`
 * — the difference is the `thinking` request param. We strip the suffix
 * before sending to the wire.
 */
export function resolveDeepSeekApiModel(modelId: string): string {
  if (modelId.endsWith('-thinking')) {
    return modelId.slice(0, -'-thinking'.length);
  }
  return modelId;
}
