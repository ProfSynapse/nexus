import { ModelSpec } from '../modelTypes';

export const GOOGLE_GEMINI_CLI_MODELS: ModelSpec[] = [
  {
    provider: 'google-gemini-cli',
    name: 'Gemini 2.5 Pro',
    apiName: 'gemini-2.5-pro',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: false,
      supportsThinking: true
    }
  },
  {
    provider: 'google-gemini-cli',
    name: 'Gemini 2.5 Flash',
    apiName: 'gemini-2.5-flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: false,
      supportsThinking: true
    }
  },
  {
    provider: 'google-gemini-cli',
    name: 'Gemini 3.1 Pro (Preview)',
    apiName: 'gemini-3.1-pro-preview',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: false,
      supportsThinking: true
    }
  },
  {
    provider: 'google-gemini-cli',
    name: 'Gemini 3.1 Flash Lite (Preview)',
    apiName: 'gemini-3.1-flash-lite-preview',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: false,
      supportsThinking: false
    }
  },
  {
    provider: 'google-gemini-cli',
    name: 'Gemini 3 Flash',
    apiName: 'gemini-3-flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: false,
      supportsThinking: false
    }
  }
];

export const GOOGLE_GEMINI_CLI_DEFAULT_MODEL = 'gemini-2.5-flash';
