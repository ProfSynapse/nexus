/**
 * Token Usage Extractor Utility
 * Location: src/services/llm/utils/TokenUsageExtractor.ts
 *
 * One normalizer for every provider's raw usage object. Adapters and the
 * stream processors call `normalize` (or `extractUsage` for a whole response)
 * and get the same `TokenUsage` shape back, cache read/write counts and any
 * provider-reported price included. Nothing downstream should re-read raw
 * provider field names.
 *
 * Shapes handled:
 * - OpenAI chat completions: prompt_tokens / completion_tokens / total_tokens,
 *   prompt_tokens_details.cached_tokens, completion_tokens_details.reasoning_tokens
 * - OpenAI Responses: input_tokens / output_tokens, input_tokens_details.cached_tokens,
 *   output_tokens_details.reasoning_tokens
 * - Anthropic: input_tokens (NET of cache), output_tokens,
 *   cache_read_input_tokens, cache_creation_input_tokens
 * - Google: promptTokenCount (gross), candidatesTokenCount, totalTokenCount,
 *   cachedContentTokenCount, thoughtsTokenCount
 * - OpenRouter: chat-completions shape plus `cost` (USD) and cost_details
 * - Already-normalized camelCase (promptTokens, cacheReadTokens, ...)
 */

import { TokenUsage } from '../adapters/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function first(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = num(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

export class TokenUsageExtractor {
  /**
   * Normalize a raw provider usage object. Returns undefined when the value is
   * not an object or carries no token counts at all.
   */
  static normalize(rawUsage: unknown): TokenUsage | undefined {
    if (!isRecord(rawUsage)) {
      return undefined;
    }
    const u = rawUsage;
    const inputDetails = isRecord(u.input_tokens_details) ? u.input_tokens_details
      : isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : undefined;
    const outputDetails = isRecord(u.output_tokens_details) ? u.output_tokens_details
      : isRecord(u.completion_tokens_details) ? u.completion_tokens_details : undefined;

    const cacheReadTokens = first(
      u.cacheReadTokens,
      u.cache_read_input_tokens,      // Anthropic
      inputDetails?.cached_tokens,    // OpenAI (both APIs), OpenRouter, Requesty
      u.cachedContentTokenCount,      // Google
      u.prompt_cache_hit_tokens,      // DeepSeek
      u.cached_tokens,
      u.cachedTokens
    );
    const cacheWriteTokens = first(
      u.cacheWriteTokens,
      u.cache_creation_input_tokens,  // Anthropic
      inputDetails?.cache_write_tokens // OpenRouter
    );

    let promptTokens = first(u.promptTokens, u.prompt_tokens, u.input_tokens, u.promptTokenCount);
    const completionTokens = first(u.completionTokens, u.completion_tokens, u.output_tokens, u.candidatesTokenCount);

    if (promptTokens === undefined && completionTokens === undefined) {
      return undefined;
    }

    // Anthropic's input_tokens excludes cache reads and writes; every other
    // provider reports gross input. Gross it up so promptTokens means the same
    // thing everywhere (and so context accounting sees the cached prefix).
    const isAnthropicShape = 'cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u;
    if (isAnthropicShape) {
      promptTokens = (promptTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
    }

    const prompt = promptTokens ?? 0;
    const completion = completionTokens ?? 0;
    const totalTokens = first(u.totalTokens, u.total_tokens, u.totalTokenCount) ?? (prompt + completion);

    const usage: TokenUsage = {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens
    };

    if (cacheReadTokens) {
      usage.cacheReadTokens = cacheReadTokens;
      usage.cachedTokens = cacheReadTokens;
    }
    if (cacheWriteTokens) {
      usage.cacheWriteTokens = cacheWriteTokens;
    }

    const reasoningTokens = first(u.reasoningTokens, u.reasoning_tokens, outputDetails?.reasoning_tokens, u.thoughtsTokenCount);
    if (reasoningTokens) {
      usage.reasoningTokens = reasoningTokens;
    }

    const audio = (num(inputDetails?.audio_tokens) ?? 0) + (num(outputDetails?.audio_tokens) ?? 0);
    const audioTokens = first(u.audioTokens, u.audio_tokens) ?? (audio > 0 ? audio : undefined);
    if (audioTokens) {
      usage.audioTokens = audioTokens;
    }

    // Provider-reported price. OpenRouter puts `cost` (USD) on the final usage
    // object when the request asked for it (`usage: { include: true }`). On a
    // BYOK request (`is_byok: true`) OpenRouter bills nothing itself and reports
    // `cost: 0`; what the user actually paid upstream is
    // `cost_details.upstream_inference_cost`, so fall back to it when `cost` is
    // absent or zero.
    const costDetails = isRecord(u.cost_details) ? u.cost_details : undefined;
    const reportedCost = num(u.cost);
    const upstreamCost = num(costDetails?.upstream_inference_cost);
    const providerCost = isRecord(u.providerCost)
      ? { totalCost: num(u.providerCost.totalCost), currency: typeof u.providerCost.currency === 'string' ? u.providerCost.currency : 'USD' }
      : { totalCost: reportedCost ? reportedCost : (upstreamCost ?? reportedCost), currency: 'USD' };
    if (providerCost.totalCost !== undefined) {
      usage.providerCost = { totalCost: providerCost.totalCost, currency: providerCost.currency };
    }

    return usage;
  }

  /**
   * Extract token usage from a whole provider response (`response.usage` or
   * Google's `response.usageMetadata`).
   */
  static extractUsage(response: unknown): TokenUsage | undefined {
    if (!isRecord(response)) {
      return undefined;
    }
    return this.normalize(response.usage) ?? this.normalize(response.usageMetadata);
  }

  /**
   * Format usage for streaming context. Alias of `normalize`, kept for callers
   * that predate the single normalizer.
   */
  static formatStreamingUsage(rawUsage: unknown): TokenUsage | undefined {
    return this.normalize(rawUsage);
  }
}
