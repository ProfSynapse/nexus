/**
 * Mistral Model Specifications
 * Includes Mistral Large 4 public preview (October 8, 2026).
 */

import { ModelSpec } from '../modelTypes';

export const MISTRAL_MODELS: ModelSpec[] = [
  {
    provider: 'mistral',
    name: 'Mistral Large Latest',
    apiName: 'mistral-large-latest',
    contextWindow: 128000,
    maxTokens: 8192,
    inputCostPerMillion: 2.00,
    outputCostPerMillion: 6.00,
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
    name: 'Mistral Saba',
    apiName: 'mistral-saba-latest',
    contextWindow: 128000,
    maxTokens: 4096,
    inputCostPerMillion: 0.20,
    outputCostPerMillion: 0.60,
    capabilities: {
      supportsJSON: false,
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
    contextWindow: 40000,
    maxTokens: 40000,
    inputCostPerMillion: 2.00,
    outputCostPerMillion: 5.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: false,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  // https://docs.mistral.ai/models/mistral-large (checked 2026-10-08).
  // Launch pricing is 50% off for two weeks; the provider does not publish
  // a separate output ceiling. Leave maxTokens unknown instead of imposing a cap.
  {
    provider: 'mistral',
    name: 'Mistral Large 4 (Le Chonk, preview)',
    apiName: 'mistral-large-4',
    releaseDate: '2026-10-06',
    contextWindow: 1000000,
    inputCostPerMillion: 0.68,
    outputCostPerMillion: 2.09,
    cacheReadCostPerMillion: 0.07,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  }
];

export const MISTRAL_DEFAULT_MODEL = 'mistral-large-latest';
