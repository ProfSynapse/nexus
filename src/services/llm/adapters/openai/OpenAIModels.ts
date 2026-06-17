/**
 * OpenAI Model Specifications
 * Updated June 2026 — pruned the GPT-5 / GPT-5.1 generation (superseded by GPT-5.2+ and the 5.4/5.5 families)
 *
 * Pricing Notes:
 * - GPT-5 family supports 90% caching discount (cached tokens: $0.125/M vs $1.25/M fresh)
 * - Caching discounts are applied automatically when prompt_tokens_details.cached_tokens > 0
 * - Pricing shown here is for Standard tier; Batch API offers 50% off, Priority costs more
 *
 * Reference: https://openai.com/api/pricing/
 */

import { ModelSpec } from '../modelTypes';

export const OPENAI_MODELS: ModelSpec[] = [
  // GPT-5.5 family (latest models)
  {
    provider: 'openai',
    name: 'GPT-5.5',
    apiName: 'gpt-5.5',
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
    provider: 'openai',
    name: 'GPT-5.5 Pro',
    apiName: 'gpt-5.5-pro',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 30.00,
    outputCostPerMillion: 180.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: false,
      supportsThinking: true
    }
  },

  // GPT-5.4 family
  {
    provider: 'openai',
    name: 'GPT-5.4',
    apiName: 'gpt-5.4',
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
    provider: 'openai',
    name: 'GPT-5.4 Mini',
    apiName: 'gpt-5.4-mini',
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
    provider: 'openai',
    name: 'GPT-5.4 Nano',
    apiName: 'gpt-5.4-nano',
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
  {
    provider: 'openai',
    name: 'GPT-5.4 Pro',
    apiName: 'gpt-5.4-pro',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 30.00,
    outputCostPerMillion: 180.00,
    capabilities: {
      supportsJSON: false,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // GPT-5.3 family
  {
    provider: 'openai',
    name: 'GPT-5.3 Chat',
    apiName: 'gpt-5.3-chat-latest',
    contextWindow: 128000,
    maxTokens: 16384,
    inputCostPerMillion: 1.75,
    outputCostPerMillion: 14.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openai',
    name: 'GPT-5.3 Codex',
    apiName: 'gpt-5.3-codex',
    contextWindow: 128000,
    maxTokens: 16384,
    inputCostPerMillion: 1.75,
    outputCostPerMillion: 14.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // GPT-5.2 family
  {
    provider: 'openai',
    name: 'GPT-5.2',
    apiName: 'gpt-5.2',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 1.75,
    outputCostPerMillion: 14.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openai',
    name: 'GPT-5.2 Pro',
    apiName: 'gpt-5.2-pro',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 21.00,
    outputCostPerMillion: 168.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  }

  // Note: o3/o4 reasoning models removed due to incompatible API (requires max_completion_tokens)
  // These models use a different parameter structure and would need special handling
];

export const OPENAI_DEFAULT_MODEL = 'gpt-5.5';
