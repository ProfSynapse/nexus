/**
 * Perplexity AI Model Definitions
 * Based on 2025 Perplexity API specifications
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
    name: 'Sonar Reasoning',
    apiName: 'sonar-reasoning',
    contextWindow: 128000,
    maxTokens: 8000,
    inputCostPerMillion: 1.00,
    outputCostPerMillion: 5.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: false,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
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
  },

  // Offline Model
  {
    provider: 'perplexity',
    name: 'r1-1776',
    apiName: 'r1-1776',
    contextWindow: 128000,
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

export const PERPLEXITY_SEARCH_MODELS = PERPLEXITY_MODELS.filter(m => 
  m.apiName !== 'r1-1776' // All models except r1-1776 have web search
);
export const PERPLEXITY_REASONING_MODELS = PERPLEXITY_MODELS.filter(m => 
  m.capabilities.supportsThinking
);
export const PERPLEXITY_OFFLINE_MODELS = PERPLEXITY_MODELS.filter(m => 
  m.apiName === 'r1-1776' // Only r1-1776 is offline
);