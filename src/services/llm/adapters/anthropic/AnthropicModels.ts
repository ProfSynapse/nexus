/**
 * Anthropic Model Specifications
 * Updated June 17, 2025 with latest Claude releases
 */

import { ModelSpec } from '../modelTypes';

export const ANTHROPIC_MODELS: ModelSpec[] = [
  // Claude models
  {
    provider: 'anthropic',
    name: 'Claude 4.5 Haiku',
    apiName: 'claude-haiku-4-5-20251001',
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

  // Claude 4.5 Opus
  {
    provider: 'anthropic',
    name: 'Claude 4.5 Opus',
    apiName: 'claude-opus-4-5-20251101',
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

  // Claude 4 models - All Claude 4+ models support extended thinking per Anthropic docs
  {
    provider: 'anthropic',
    name: 'Claude 4 Opus',
    apiName: 'claude-opus-4-0',
    contextWindow: 200000,
    maxTokens: 32000,
    inputCostPerMillion: 15.00,
    outputCostPerMillion: 75.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'anthropic',
    name: 'Claude 4 Sonnet',
    apiName: 'claude-sonnet-4-0',
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
    provider: 'anthropic',
    name: 'Claude 4.5 Sonnet',
    apiName: 'claude-sonnet-4-5-20250929',
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
    provider: 'anthropic',
    name: 'Claude 4.5 Sonnet (1M)',
    apiName: 'claude-sonnet-4-5-20250929',
    contextWindow: 1000000,
    maxTokens: 64000,
    inputCostPerMillion: 3.00,
    outputCostPerMillion: 15.00,
    betaHeaders: ['context-1m-2025-08-07'],
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  }
];

export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';