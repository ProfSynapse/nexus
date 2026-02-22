/**
 * OpenAI Codex Model Specifications
 * Location: src/services/llm/adapters/openai-codex/OpenAICodexModels.ts
 *
 * Defines models available through the Codex endpoint (ChatGPT subscription).
 * All costs are $0 since these models are included in the user's ChatGPT
 * subscription — no per-token API billing.
 *
 * Used by: ModelRegistry (AI_MODELS), OpenAICodexAdapter, ProviderManager
 */

import { ModelSpec } from '../modelTypes';

export const OPENAI_CODEX_MODELS: ModelSpec[] = [
  {
    provider: 'openai-codex',
    name: 'GPT-5.3 Codex',
    apiName: 'gpt-5.3-codex',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'openai-codex',
    name: 'GPT-5.2 Codex',
    apiName: 'gpt-5.2-codex',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'openai-codex',
    name: 'GPT-5.2',
    apiName: 'gpt-5.2',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'openai-codex',
    name: 'GPT-5.1 Codex',
    apiName: 'gpt-5.1-codex',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'openai-codex',
    name: 'GPT-5.1 Codex Max',
    apiName: 'gpt-5.1-codex-max',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'openai-codex',
    name: 'GPT-5.1 Codex Mini',
    apiName: 'gpt-5.1-codex-mini',
    contextWindow: 200000,
    maxTokens: 64000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  }
];

export const OPENAI_CODEX_DEFAULT_MODEL = 'gpt-5.3-codex';
