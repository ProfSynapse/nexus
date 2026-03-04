/**
 * OpenAI Model Specifications
 * Updated March 2026 - Added GPT-5.3 family
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
  // GPT-5.3 family (latest models)
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
  },

  // GPT-5 model family
  {
    provider: 'openai',
    name: 'GPT-5.1',
    apiName: 'gpt-5.1-2025-11-13',
    contextWindow: 400000,
    maxTokens: 128000,
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
    provider: 'openai',
    name: 'GPT-5',
    apiName: 'gpt-5',
    contextWindow: 400000,
    maxTokens: 128000,
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
    provider: 'openai',
    name: 'GPT-5 Mini',
    apiName: 'gpt-5-mini',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 0.25,
    outputCostPerMillion: 2.00,
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
    name: 'GPT-5 Nano',
    apiName: 'gpt-5-nano',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 0.05,
    outputCostPerMillion: 0.40,
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

export const OPENAI_DEFAULT_MODEL = 'gpt-5.1-2025-11-13';