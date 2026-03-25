/**
 * OpenRouter Model Specifications
 * OpenRouter provides access to multiple providers through a unified API
 * Updated March 2026 with GPT-5.3, Claude Sonnet 4.6, and Gemini 3.1 models
 */

import { ModelSpec } from '../modelTypes';

// OpenRouter provides access to models from other providers
// Each model has its own specific API name in OpenRouter
export const OPENROUTER_MODELS: ModelSpec[] = [
  // OpenAI GPT-5.4 models via OpenRouter
  {
    provider: 'openrouter',
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
    provider: 'openrouter',
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

  // OpenAI GPT-5.3 models via OpenRouter
  {
    provider: 'openrouter',
    name: 'GPT-5.3 Chat',
    apiName: 'openai/gpt-5.3-chat-latest',
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
    provider: 'openrouter',
    name: 'GPT-5.3 Codex',
    apiName: 'openai/gpt-5.3-codex',
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

  // OpenAI GPT-5.2 models via OpenRouter
  {
    provider: 'openrouter',
    name: 'GPT-5.2',
    apiName: 'openai/gpt-5.2',
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
    provider: 'openrouter',
    name: 'GPT-5.2 Pro',
    apiName: 'openai/gpt-5.2-pro',
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

  // OpenAI GPT-5 models via OpenRouter
  {
    provider: 'openrouter',
    name: 'GPT-5.1',
    apiName: 'openai/gpt-5.1',
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
    provider: 'openrouter',
    name: 'GPT-5',
    apiName: 'openai/gpt-5',
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
    provider: 'openrouter',
    name: 'GPT-5 Mini',
    apiName: 'openai/gpt-5-mini',
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
    provider: 'openrouter',
    name: 'GPT-5 Nano',
    apiName: 'openai/gpt-5-nano',
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
  },

  // Google models via OpenRouter
  {
    provider: 'openrouter',
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
    provider: 'openrouter',
    name: 'Gemini 3.1 Flash Lite Preview',
    apiName: 'google/gemini-3.1-flash-lite-preview',
    contextWindow: 1048576,
    maxTokens: 64000,
    inputCostPerMillion: 0.25,
    outputCostPerMillion: 1.50,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Gemini 3.0 Pro Preview',
    apiName: 'google/gemini-3-pro-preview',
    contextWindow: 1048576,
    maxTokens: 8192,
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
    provider: 'openrouter',
    name: 'Gemini 3.0 Flash Preview',
    apiName: 'google/gemini-3-flash-preview',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0.50,
    outputCostPerMillion: 3.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
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
    provider: 'openrouter',
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

  // Anthropic models via OpenRouter
  {
    provider: 'openrouter',
    name: 'Claude Opus 4.6',
    apiName: 'anthropic/claude-opus-4.6',
    contextWindow: 200000,
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
    provider: 'openrouter',
    name: 'Claude Opus 4.6 (1M)',
    apiName: 'anthropic/claude-opus-4.6',
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
    provider: 'openrouter',
    name: 'Claude Sonnet 4.6',
    apiName: 'anthropic/claude-sonnet-4.6',
    contextWindow: 200000,
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
    provider: 'openrouter',
    name: 'Claude Sonnet 4.6 (1M)',
    apiName: 'anthropic/claude-sonnet-4.6',
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
    provider: 'openrouter',
    name: 'Claude 4.5 Opus',
    apiName: 'anthropic/claude-opus-4.5',
    contextWindow: 200000,
    maxTokens: 32000,
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
    provider: 'openrouter',
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
    provider: 'openrouter',
    name: 'Claude 4.5 Sonnet',
    apiName: 'anthropic/claude-sonnet-4.5',
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
];

export const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-5.1';
