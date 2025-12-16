/**
 * Requesty Model Specifications
 * Requesty provides access to multiple providers through a unified API
 * Updated June 17, 2025
 */

import { ModelSpec } from '../modelTypes';

// Requesty provides access to models from other providers
// Each model has its own specific API name in Requesty
export const REQUESTY_MODELS: ModelSpec[] = [
  // OpenAI models via Requesty
  {
    provider: 'requesty',
    name: 'GPT-5.2',
    apiName: 'openai/gpt-5.2',
    contextWindow: 200000,
    maxTokens: 65536,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 15.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'requesty',
    name: 'GPT-5.2 Pro',
    apiName: 'openai/gpt-5.2-pro',
    contextWindow: 200000,
    maxTokens: 65536,
    inputCostPerMillion: 15.00,
    outputCostPerMillion: 60.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: false, // Pro model does not support streaming
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'GPT-5.2 Mini',
    apiName: 'openai/gpt-5.2-mini',
    contextWindow: 200000,
    maxTokens: 65536,
    inputCostPerMillion: 0.25,
    outputCostPerMillion: 1.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'requesty',
    name: 'GPT-5 Nano',
    apiName: 'openai/gpt-5-nano',
    contextWindow: 200000,
    maxTokens: 65536,
    inputCostPerMillion: 0.05,
    outputCostPerMillion: 0.20,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'requesty',
    name: 'o3',
    apiName: 'openai/o3',
    contextWindow: 200000,
    maxTokens: 100000,
    inputCostPerMillion: 2.00,
    outputCostPerMillion: 8.00,
    capabilities: {
      supportsJSON: false,
      supportsImages: false,
      supportsFunctions: false,
      supportsStreaming: false,
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'o3 Pro',
    apiName: 'openai/o3-pro',
    contextWindow: 200000,
    maxTokens: 100000,
    inputCostPerMillion: 20.00,
    outputCostPerMillion: 80.00,
    capabilities: {
      supportsJSON: false,
      supportsImages: false,
      supportsFunctions: false,
      supportsStreaming: false,
      supportsThinking: true
    }
  },
  {
    provider: 'requesty',
    name: 'o4 Mini',
    apiName: 'openai/o4-mini',
    contextWindow: 200000,
    maxTokens: 100000,
    inputCostPerMillion: 1.10,
    outputCostPerMillion: 4.40,
    capabilities: {
      supportsJSON: false,
      supportsImages: false,
      supportsFunctions: false,
      supportsStreaming: false,
      supportsThinking: true
    }
  },

  // Google models via Requesty
  {
    provider: 'requesty',
    name: 'Gemini 2.5 Pro Experimental',
    apiName: 'google/gemini-2.5-pro',
    contextWindow: 1048576,
    maxTokens: 65535,
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
      supportsThinking: false
    }
  },

  // Anthropic models via Requesty
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
  {
    provider: 'requesty',
    name: 'Claude 4 Sonnet',
    apiName: 'anthropic/claude-sonnet-4-20250514',
    contextWindow: 200000,
    maxTokens: 64000,
    inputCostPerMillion: 3.00,
    outputCostPerMillion: 15.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
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

export const REQUESTY_DEFAULT_MODEL = 'anthropic/claude-sonnet-4-20250514';