/**
 * Anthropic Model Specifications
 * Updated June 2026 — pruned the Claude 4.5 Opus/Sonnet generation (superseded by Opus 4.8 / Sonnet 4.6)
 *
 * Cache pricing (see anthropic.com/pricing):
 *   cache read  = 0.1  × input, except where an entry notes a published rate
 *   cache write = 1.25 × input (5-minute TTL; the adapter requests ephemeral)
 * cacheRead/WriteCostPerMillion below are derived from that structure unless noted.
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
    cacheReadCostPerMillion: 0.1,
    cacheWriteCostPerMillion: 1.25,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Claude Fable 5.1 (native 1M context, 128k output; thinking is always on)
  {
    provider: 'anthropic',
    name: 'Claude Fable 5.1',
    apiName: 'claude-fable-5-1',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 10.00,
    outputCostPerMillion: 50.00,
    // Published cache-read rate is $0.25 (0.025x input), not the 0.1x structure.
    cacheReadCostPerMillion: 0.25,
    cacheWriteCostPerMillion: 12.5,
    supportsSamplingParams: false,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Claude Fable 5
  {
    provider: 'anthropic',
    name: 'Claude Fable 5',
    apiName: 'claude-fable-5',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 10.00,
    outputCostPerMillion: 50.00,
    cacheReadCostPerMillion: 1,
    cacheWriteCostPerMillion: 12.5,
    supportsSamplingParams: false,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Claude Opus 5.5 (native 1M context; thinking cannot be disabled, forced tool_choice is rejected)
  {
    provider: 'anthropic',
    name: 'Claude Opus 5.5',
    apiName: 'claude-opus-5-5',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 4.00,
    outputCostPerMillion: 20.00,
    // Published cache-read rate is $0.20 (0.05x input), not the 0.1x structure.
    cacheReadCostPerMillion: 0.2,
    cacheWriteCostPerMillion: 5,
    supportsSamplingParams: false,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Claude Opus 5 (native 1M context, no beta header required)
  {
    provider: 'anthropic',
    name: 'Claude Opus 5',
    apiName: 'claude-opus-5',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 25.00,
    cacheReadCostPerMillion: 0.5,
    cacheWriteCostPerMillion: 6.25,
    supportsSamplingParams: false,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Claude Opus 4.8
  {
    provider: 'anthropic',
    name: 'Claude Opus 4.8',
    apiName: 'claude-opus-4-8',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 25.00,
    cacheReadCostPerMillion: 0.5,
    cacheWriteCostPerMillion: 6.25,
    supportsSamplingParams: false,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Claude Opus 4.7
  {
    provider: 'anthropic',
    name: 'Claude Opus 4.7',
    apiName: 'claude-opus-4-7',
    contextWindow: 200000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 25.00,
    cacheReadCostPerMillion: 0.5,
    cacheWriteCostPerMillion: 6.25,
    supportsSamplingParams: false,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Claude Opus 4.7 (1M context)
  {
    provider: 'anthropic',
    name: 'Claude Opus 4.7 (1M)',
    apiName: 'claude-opus-4-7',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 25.00,
    cacheReadCostPerMillion: 0.5,
    cacheWriteCostPerMillion: 6.25,
    betaHeaders: ['context-1m-2025-08-07'],
    supportsSamplingParams: false,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Claude Opus 4.6
  {
    provider: 'anthropic',
    name: 'Claude Opus 4.6',
    apiName: 'claude-opus-4-6',
    contextWindow: 200000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 25.00,
    cacheReadCostPerMillion: 0.5,
    cacheWriteCostPerMillion: 6.25,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Claude Opus 4.6 (1M context)
  {
    provider: 'anthropic',
    name: 'Claude Opus 4.6 (1M)',
    apiName: 'claude-opus-4-6',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 25.00,
    cacheReadCostPerMillion: 0.5,
    cacheWriteCostPerMillion: 6.25,
    betaHeaders: ['context-1m-2025-08-07'],
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Claude Sonnet 5 (native 1M context, no beta header required)
  {
    provider: 'anthropic',
    name: 'Claude Sonnet 5',
    apiName: 'claude-sonnet-5',
    contextWindow: 1000000,
    maxTokens: 128000,
    // Docs list Sonnet 5 below the 4.6-generation Sonnet price point.
    inputCostPerMillion: 2.00,
    outputCostPerMillion: 10.00,
    cacheReadCostPerMillion: 0.2,
    cacheWriteCostPerMillion: 2.5,
    supportsSamplingParams: false,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Claude Sonnet 4.6
  {
    provider: 'anthropic',
    name: 'Claude Sonnet 4.6',
    apiName: 'claude-sonnet-4-6',
    contextWindow: 200000,
    maxTokens: 64000,
    inputCostPerMillion: 3.00,
    outputCostPerMillion: 15.00,
    cacheReadCostPerMillion: 0.3,
    cacheWriteCostPerMillion: 3.75,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Claude Sonnet 4.6 (1M context)
  {
    provider: 'anthropic',
    name: 'Claude Sonnet 4.6 (1M)',
    apiName: 'claude-sonnet-4-6',
    contextWindow: 1000000,
    maxTokens: 64000,
    inputCostPerMillion: 3.00,
    outputCostPerMillion: 15.00,
    cacheReadCostPerMillion: 0.3,
    cacheWriteCostPerMillion: 3.75,
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
