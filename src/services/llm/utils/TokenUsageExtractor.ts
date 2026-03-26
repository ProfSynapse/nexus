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

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function getNestedRecord(value: unknown, key: string): UnknownRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nestedValue = value[key];
  return isRecord(nestedValue) ? nestedValue : undefined;
}

function getTruthyNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const candidate = value[key];
  return typeof candidate === 'number' && Boolean(candidate) ? candidate : undefined;
}

function getFirstTruthyNumber(value: unknown, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = getTruthyNumber(value, key);
    if (candidate !== undefined) {
      return candidate;
    }
  }

  return undefined;
}

export class TokenUsageExtractor {
  /**
   * Extract token usage from provider response
   * Supports multiple provider formats and detailed token breakdowns
   */
  static extractUsage(response: unknown): TokenUsage | undefined {
    // Check for usage data
    const usageData = getNestedRecord(response, 'usage');
    if (!usageData) {
      return undefined;
    }

    const usage: TokenUsage = {
      promptTokens: getFirstTruthyNumber(usageData, 'prompt_tokens', 'input_tokens') ?? 0,
      completionTokens: getFirstTruthyNumber(usageData, 'completion_tokens', 'output_tokens') ?? 0,
      totalTokens: getTruthyNumber(usageData, 'total_tokens') ?? 0
    };

    const promptTokenDetails = getNestedRecord(usageData, 'prompt_tokens_details');
    const completionTokenDetails = getNestedRecord(usageData, 'completion_tokens_details');

    // Extract detailed token breakdowns (OpenAI format)
    const cachedTokens = getTruthyNumber(promptTokenDetails, 'cached_tokens');
    if (cachedTokens !== undefined) {
      usage.cachedTokens = cachedTokens;
    }

    const reasoningTokens = getTruthyNumber(completionTokenDetails, 'reasoning_tokens');
    if (reasoningTokens !== undefined) {
      usage.reasoningTokens = reasoningTokens;
    }

    // Audio tokens (sum of input and output if present)
    const inputAudio = getTruthyNumber(promptTokenDetails, 'audio_tokens') ?? 0;
    const outputAudio = getTruthyNumber(completionTokenDetails, 'audio_tokens') ?? 0;
    if (inputAudio + outputAudio > 0) {
      usage.audioTokens = inputAudio + outputAudio;
    }

    return usage;
  }

  /**
   * Format usage for streaming context (convert snake_case to camelCase)
   */
  static formatStreamingUsage(rawUsage: unknown): TokenUsage | undefined {
    if (!isRecord(rawUsage)) {
      return undefined;
    }

    return {
      promptTokens: getFirstTruthyNumber(rawUsage, 'prompt_tokens', 'promptTokens') ?? 0,
      completionTokens: getFirstTruthyNumber(rawUsage, 'completion_tokens', 'completionTokens') ?? 0,
      totalTokens: getFirstTruthyNumber(rawUsage, 'total_tokens', 'totalTokens') ?? 0,
      cachedTokens: getFirstTruthyNumber(rawUsage, 'cached_tokens', 'cachedTokens'),
      reasoningTokens: getFirstTruthyNumber(rawUsage, 'reasoning_tokens', 'reasoningTokens'),
      audioTokens: getFirstTruthyNumber(rawUsage, 'audio_tokens', 'audioTokens')
    };
  }
}
