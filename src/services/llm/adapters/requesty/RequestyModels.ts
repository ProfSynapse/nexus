/**
 * Requesty Model Specifications
 * Requesty provides access to multiple providers through a unified API
 * Updated June 10, 2026 — aligned with OpenRouterModels.ts metadata.
 *
 * Slug conventions (verified live against router.requesty.ai/v1/models,
 * 2026-06-12):
 * - OpenAI slugs match OpenRouter exactly (openai/gpt-5.5).
 * - Google slugs mostly match (google/gemini-3.1-pro-preview), EXCEPT
 *   Gemini 3.5 Flash, which Requesty only serves as vertex/gemini-3.5-flash
 *   (no google/ alias yet — google/gemini-3.5-flash returns "Provider
 *   and/or model not supported").
 * - Anthropic slugs use Anthropic's upstream dashed IDs
 *   (anthropic/claude-opus-4-8), NOT OpenRouter's dotted renames
 *   (anthropic/claude-opus-4.8).
 */

import { ModelSpec } from '../modelTypes';

// Requesty provides access to models from other providers
// Each model has its own specific API name in Requesty
export const REQUESTY_MODELS: ModelSpec[] = [
  // OpenAI models via Requesty
  {
    provider: 'requesty',
    name: 'GPT-5.5',
    apiName: 'openai/gpt-5.5',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 30.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'GPT-5.4',
    apiName: 'openai/gpt-5.4',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 2.50,
    outputCostPerMillion: 15.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'GPT-5.4 Mini',
    apiName: 'openai/gpt-5.4-mini',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 0.75,
    outputCostPerMillion: 4.50,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'GPT-5.4 Nano',
    apiName: 'openai/gpt-5.4-nano',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 0.20,
    outputCostPerMillion: 1.25,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Google models via Requesty
  {
    provider: 'requesty',
    name: 'Gemini 3.5 Flash',
    apiName: 'vertex/gemini-3.5-flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 1.50,
    outputCostPerMillion: 9.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'Gemini 3.1 Pro Preview',
    apiName: 'google/gemini-3.1-pro-preview',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 2.00,
    outputCostPerMillion: 12.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'Gemini 2.5 Pro',
    apiName: 'google/gemini-2.5-pro',
    contextWindow: 1048576,
    maxTokens: 66000,
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 10.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'Gemini 2.5 Flash',
    apiName: 'google/gemini-2.5-flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.60,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Anthropic models via Requesty (dashed upstream slugs)
  {
    provider: 'requesty',
    name: 'Claude Fable 5',
    apiName: 'anthropic/claude-fable-5',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 10.00,
    outputCostPerMillion: 50.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'Claude Opus 4.8',
    apiName: 'anthropic/claude-opus-4-8',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 25.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'Claude Sonnet 5',
    apiName: 'anthropic/claude-sonnet-5',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 3.00,
    outputCostPerMillion: 15.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'Claude Sonnet 4.6',
    apiName: 'anthropic/claude-sonnet-4-6',
    contextWindow: 1000000,
    maxTokens: 64000,
    inputCostPerMillion: 3.00,
    outputCostPerMillion: 15.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'Claude 4.5 Haiku',
    apiName: 'anthropic/claude-haiku-4-5',
    contextWindow: 200000,
    maxTokens: 64000,
    inputCostPerMillion: 1.00,
    outputCostPerMillion: 5.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Z.ai / Moonshot models via Requesty (first-party provider slugs,
  // verified live against router.requesty.ai/v1/models 2026-06-17)
  {
    provider: 'requesty',
    name: 'GLM 5.2',
    apiName: 'zai/glm-5.2',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 1.40,
    outputCostPerMillion: 4.40,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'Kimi K2.7 Code',
    apiName: 'moonshot/kimi-k2.7-code',
    contextWindow: 262144,
    maxTokens: 128000,
    inputCostPerMillion: 0.95,
    outputCostPerMillion: 4.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Mistral models via Requesty
  {
    provider: 'requesty',
    name: 'Mistral Large',
    apiName: 'mistral/mistral-large-latest',
    contextWindow: 131000,
    maxTokens: 130000,
    inputCostPerMillion: 2.00,
    outputCostPerMillion: 6.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  }
];

export const REQUESTY_DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6';
