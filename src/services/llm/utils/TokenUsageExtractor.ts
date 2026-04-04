/**
 * Token Usage Extractor Utility
 * Location: src/services/llm/utils/TokenUsageExtractor.ts
 *
 * Extracted from BaseAdapter.ts to follow Single Responsibility Principle.
 * Handles extraction of token usage information from different provider response formats.
 *
 * Usage:
 * - Used by BaseAdapter and all provider adapters
 * - Normalizes token usage data from different provider formats (OpenAI, Anthropic, Google, etc.)
 * - Extracts detailed token breakdowns (cached, reasoning, audio tokens)
 */

import { TokenUsage } from '../adapters/types';

interface UsageDetails {
  cached_tokens?: number;
  reasoning_tokens?: number;
  audio_tokens?: number;
}

interface ProviderUsage {
  prompt_tokens?: number;
  input_tokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cached_tokens?: number;
  cachedTokens?: number;
  reasoning_tokens?: number;
  reasoningTokens?: number;
  audio_tokens?: number;
  audioTokens?: number;
  prompt_tokens_details?: UsageDetails;
  completion_tokens_details?: UsageDetails;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asProviderUsage(value: unknown): ProviderUsage | undefined {
  return isRecord(value) ? value as ProviderUsage : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export class TokenUsageExtractor {
  /**
   * Extract token usage from provider response
   * Supports multiple provider formats and detailed token breakdowns
   */
  static extractUsage(response: unknown): TokenUsage | undefined {
    const usageData = isRecord(response) ? asProviderUsage(response.usage) : undefined;

    // Check for usage data
    if (!usageData) {
      return undefined;
    }

    const usage: TokenUsage = {
      promptTokens: getNumber(usageData.prompt_tokens) ?? getNumber(usageData.input_tokens) ?? 0,
      completionTokens: getNumber(usageData.completion_tokens) ?? getNumber(usageData.output_tokens) ?? 0,
      totalTokens: getNumber(usageData.total_tokens) ?? 0
    };

    // Extract detailed token breakdowns (OpenAI format)
    const promptDetails = asProviderUsage(usageData.prompt_tokens_details);
    const completionDetails = asProviderUsage(usageData.completion_tokens_details);
    const cachedTokens = getNumber(promptDetails?.cached_tokens);
    if (cachedTokens) {
      usage.cachedTokens = cachedTokens;
    }

    const reasoningTokens = getNumber(completionDetails?.reasoning_tokens);
    if (reasoningTokens) {
      usage.reasoningTokens = reasoningTokens;
    }

    // Audio tokens (sum of input and output if present)
    const inputAudio = getNumber(promptDetails?.audio_tokens) ?? 0;
    const outputAudio = getNumber(completionDetails?.audio_tokens) ?? 0;
    if (inputAudio + outputAudio > 0) {
      usage.audioTokens = inputAudio + outputAudio;
    }

    return usage;
  }

  /**
   * Format usage for streaming context (convert snake_case to camelCase)
   */
  static formatStreamingUsage(rawUsage: unknown): TokenUsage | undefined {
    const usageData = asProviderUsage(rawUsage);

    if (!usageData) {
      return undefined;
    }

    return {
      promptTokens: getNumber(usageData.prompt_tokens) ?? getNumber(usageData.promptTokens) ?? 0,
      completionTokens: getNumber(usageData.completion_tokens) ?? getNumber(usageData.completionTokens) ?? 0,
      totalTokens: getNumber(usageData.total_tokens) ?? getNumber(usageData.totalTokens) ?? 0,
      cachedTokens: getNumber(usageData.cached_tokens) ?? getNumber(usageData.cachedTokens),
      reasoningTokens: getNumber(usageData.reasoning_tokens) ?? getNumber(usageData.reasoningTokens),
      audioTokens: getNumber(usageData.audio_tokens) ?? getNumber(usageData.audioTokens)
    };
  }
}
