/**
 * Google Model Specifications
 * Updated October 2026 — added Gemini 4 Argon.
 *
 * Gemini 3.6, 3.7 and 3.8 Flash pricing is Google's introductory rate
 * ($0.75/$3.75 per 1M, cache read $0.075) which holds through December 31,
 * 2026; it doubles to $1.50/$7.50 (cache read $0.15) on January 1, 2027.
 * Revisit then. (3.6 was wrongly carried at the post-promo price until
 * September 2026 — both Google's page and OpenRouter's listing say $0.75.)
 *
 * `cacheReadCostPerMillion` is the "context caching" price from
 * ai.google.dev/gemini-api/docs/pricing (implicit and explicit cache hits are
 * billed the same). Google bills no cache write per token — only hourly
 * storage for explicit caches, which the app does not create — so no
 * `cacheWriteCostPerMillion`.
 */

import { ModelSpec } from '../modelTypes';

export const GOOGLE_ARGON_MODEL = 'gemini-4-argon';

export const GOOGLE_MODELS: ModelSpec[] = [
  {
    provider: 'google',
    name: 'Gemini 4 Argon',
    apiName: GOOGLE_ARGON_MODEL,
    releaseDate: '2026-10-13',
    // Shared input + thinking + output window. The authenticated models.get
    // listing publishes 32,768 output tokens; streaming permits an explicit
    // allowance up to 65,536 without the separate long-decode protocol.
    contextWindow: 1048576,
    maxTokens: 32768,
    // https://ai.google.dev/gemini-api/docs/pricing
    // Introductory rates through November 30, 2026; double to $4/$20/$0.20
    // (input/output/implicit cache read) on December 1, 2026. Revisit then.
    inputCostPerMillion: 2,
    outputCostPerMillion: 10,
    cacheReadCostPerMillion: 0.1,
    supportsSamplingParams: false,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Gemini 3.8 models
  {
    provider: 'google',
    name: 'Gemini 3.8 Flash',
    apiName: 'gemini-3.8-flash',
    releaseDate: '2026-09-02',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0.75,
    outputCostPerMillion: 3.75,
    cacheReadCostPerMillion: 0.075,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Gemini 3.7 models
  {
    provider: 'google',
    name: 'Gemini 3.7 Flash',
    apiName: 'gemini-3.7-flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0.75,
    outputCostPerMillion: 3.75,
    cacheReadCostPerMillion: 0.075,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Gemini 3.6 models
  {
    provider: 'google',
    name: 'Gemini 3.6 Flash',
    apiName: 'gemini-3.6-flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0.75,
    outputCostPerMillion: 3.75,
    cacheReadCostPerMillion: 0.075,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Gemini 3.5 models
  {
    provider: 'google',
    name: 'Gemini 3.5 Flash',
    apiName: 'gemini-3.5-flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 1.50,
    outputCostPerMillion: 9.00,
    cacheReadCostPerMillion: 0.15,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'google',
    name: 'Gemini 3.5 Flash-Lite',
    apiName: 'gemini-3.5-flash-lite',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0.30,
    outputCostPerMillion: 2.50,
    cacheReadCostPerMillion: 0.03, // not on Google's pricing page; OpenRouter's listing (0.1× input, same as the family)
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Gemini 3.1 models
  {
    provider: 'google',
    name: 'Gemini 3.1 Pro Preview',
    apiName: 'gemini-3.1-pro-preview',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 2.00,
    outputCostPerMillion: 12.00,
    cacheReadCostPerMillion: 0.20, // ≤200k-token prompts; >200k is $0.40 (not modelled)
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
];

export const GOOGLE_DEFAULT_MODEL = 'gemini-3.1-pro-preview';
