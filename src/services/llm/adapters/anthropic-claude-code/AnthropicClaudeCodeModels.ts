import { ModelSpec } from '../modelTypes';

export const ANTHROPIC_CLAUDE_CODE_MODELS: ModelSpec[] = [
  {
    provider: 'anthropic-claude-code',
    name: 'Claude 4.5 Haiku',
    apiName: 'claude-haiku-4-5-20251001',
    contextWindow: 200000,
    maxTokens: 64000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'anthropic-claude-code',
    name: 'Claude Sonnet 5',
    apiName: 'claude-sonnet-5',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'anthropic-claude-code',
    name: 'Claude Sonnet 4.6',
    apiName: 'claude-sonnet-4-6',
    contextWindow: 200000,
    maxTokens: 64000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'anthropic-claude-code',
    name: 'Claude Fable 5.1',
    apiName: 'claude-fable-5-1',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'anthropic-claude-code',
    name: 'Claude Fable 5',
    apiName: 'claude-fable-5',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'anthropic-claude-code',
    name: 'Claude Opus 5',
    apiName: 'claude-opus-5',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'anthropic-claude-code',
    name: 'Claude Opus 4.7',
    apiName: 'claude-opus-4-7',
    contextWindow: 200000,
    maxTokens: 128000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'anthropic-claude-code',
    name: 'Claude Opus 4.6',
    apiName: 'claude-opus-4-6',
    contextWindow: 200000,
    maxTokens: 128000,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  }
];

export const ANTHROPIC_CLAUDE_CODE_DEFAULT_MODEL = 'claude-sonnet-5';
