/**
 * Perplexity AI Model Definitions
 * Based on April 2026 Perplexity API specifications
 * Active models: sonar, sonar-pro, sonar-reasoning-pro, sonar-deep-research
 * Removed: sonar-reasoning (deprecated Dec 15 2025), r1-1776 (removed Aug 1 2025)
 */

import { ModelSpec } from '../modelTypes';

export const PERPLEXITY_MODELS: ModelSpec[] = [
  // Search Models (Online)
  {
    provider: 'perplexity',
    name: 'Sonar',
    apiName: 'sonar',
    contextWindow: 128000,
    maxTokens: 8000,
    inputCostPerMillion: 1.00,
    outputCostPerMillion: 1.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: false,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'perplexity',
    name: 'Sonar Pro',
    apiName: 'sonar-pro',
    contextWindow: 200000,
    maxTokens: 8000,
    inputCostPerMillion: 3.00,
    outputCostPerMillion: 15.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: false,
      supportsStreaming: true,
      supportsThinking: false
    }
  },

  // Reasoning Models
  {
    provider: 'perplexity',
    name: 'Sonar Reasoning Pro',
    apiName: 'sonar-reasoning-pro',
    contextWindow: 200000,
    maxTokens: 8000,
    inputCostPerMillion: 2.00,
    outputCostPerMillion: 8.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: false,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Research Models
  {
    provider: 'perplexity',
    name: 'Sonar Deep Research',
    apiName: 'sonar-deep-research',
    contextWindow: 200000,
    maxTokens: 8000,
    inputCostPerMillion: 2.00,
    outputCostPerMillion: 8.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: false,
      supportsStreaming: true,
      supportsThinking: false
    }
  }
];

export const PERPLEXITY_DEFAULT_MODEL = 'sonar-pro';

// All current models support web search
export const PERPLEXITY_SEARCH_MODELS = PERPLEXITY_MODELS;

// Models that support reasoning/thinking (sonar-reasoning-pro)
export const PERPLEXITY_REASONING_MODELS = PERPLEXITY_MODELS.filter(m =>
  m.capabilities.supportsThinking
);