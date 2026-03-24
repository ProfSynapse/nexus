import { ModelSpec } from '../modelTypes';

/**
 * Base GitHub Copilot Models.
 * At runtime, the adapter will query the /models endpoint to get the real available slugs 
 * and merge them into or overwrite these, ensuring we have exactly the slugs Copilot expects.
 */
export const GITHUB_COPILOT_MODELS: ModelSpec[] = [
  {
    provider: 'github-copilot',
    name: 'Claude Sonnet 4.6 (Copilot)',
    apiName: 'claude-3.7-sonnet', // Real Copilot slug fallback
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
    provider: 'github-copilot',
    name: 'Claude Opus 4.6 (Copilot)',
    apiName: 'claude-3.7-sonnet', // Real Copilot slug fallback (Opus may not be available)
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
    provider: 'github-copilot',
    name: 'GPT-5.4 (Copilot)',
    apiName: 'gpt-4o', // Real Copilot slug fallback
    contextWindow: 1050000,
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
    provider: 'github-copilot',
    name: 'Gemini 3.1 Pro (Preview Copilot)',
    apiName: 'gemini-2.0-flash-001', // Real Copilot slug fallback
    contextWindow: 1050000,
    maxTokens: 65000,
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

export const GITHUB_COPILOT_DEFAULT_MODEL = 'gpt-5.4';
