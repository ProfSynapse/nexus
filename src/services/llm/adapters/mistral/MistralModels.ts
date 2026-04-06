/**
 * Mistral Model Specifications
 * Updated April 6, 2026 against current Mistral Docs model catalog.
 */

import { ModelSpec } from '../modelTypes';

export const MISTRAL_MODELS: ModelSpec[] = [
  {
    provider: 'mistral',
    name: 'Mistral Large Latest',
    apiName: 'mistral-large-latest',
    contextWindow: 256000,
    maxTokens: 8192,
    inputCostPerMillion: 0.50,
    outputCostPerMillion: 1.50,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'mistral',
    name: 'Mistral Medium Latest',
    apiName: 'mistral-medium-latest',
    contextWindow: 128000,
    maxTokens: 8192,
    inputCostPerMillion: 0.40,
    outputCostPerMillion: 2.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'mistral',
    name: 'Mistral Small Latest',
    apiName: 'mistral-small-latest',
    contextWindow: 128000,
    maxTokens: 8192,
    inputCostPerMillion: 0.10,
    outputCostPerMillion: 0.30,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'mistral',
    name: 'Devstral Latest',
    apiName: 'devstral-latest',
    contextWindow: 256000,
    maxTokens: 8192,
    inputCostPerMillion: 0.40,
    outputCostPerMillion: 2.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'mistral',
    name: 'Ministral 3 14B Latest',
    apiName: 'ministral-14b-latest',
    contextWindow: 256000,
    maxTokens: 8192,
    inputCostPerMillion: 0.20,
    outputCostPerMillion: 0.20,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'mistral',
    name: 'Ministral 3 8B Latest',
    apiName: 'ministral-8b-latest',
    contextWindow: 256000,
    maxTokens: 8192,
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.15,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'mistral',
    name: 'Ministral 3 3B Latest',
    apiName: 'ministral-3b-latest',
    contextWindow: 256000,
    maxTokens: 8192,
    inputCostPerMillion: 0.10,
    outputCostPerMillion: 0.10,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'mistral',
    name: 'Magistral Medium',
    apiName: 'magistral-medium-latest',
    contextWindow: 128000,
    maxTokens: 32768,
    inputCostPerMillion: 2.00,
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
    provider: 'mistral',
    name: 'Magistral Small',
    apiName: 'magistral-small-latest',
    contextWindow: 128000,
    maxTokens: 32768,
    inputCostPerMillion: 0.50,
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
    provider: 'mistral',
    name: 'Codestral Latest',
    apiName: 'codestral-latest',
    contextWindow: 128000,
    maxTokens: 8192,
    inputCostPerMillion: 0.30,
    outputCostPerMillion: 0.90,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'mistral',
    name: 'Voxtral Small Latest',
    apiName: 'voxtral-small-latest',
    contextWindow: 32000,
    maxTokens: 8192,
    inputCostPerMillion: 0.10,
    outputCostPerMillion: 0.30,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  }
];

export const MISTRAL_DEFAULT_MODEL = 'mistral-large-latest';
