import { Platform } from 'obsidian';
import type { ModelSpec } from '../modelTypes';

// ACP session/new advertises this id for the signed-in Google account.
export const GOOGLE_GEMINI_CLI_DEFAULT_MODEL = 'gemini-4-neon';
export const ANTIGRAVITY_PRINT_DEFAULT_MODEL = 'gemini-3.5-flash';

export const GOOGLE_GEMINI_CLI_MODELS: ModelSpec[] = [
  {
    provider: 'google-gemini-cli',
    name: 'Gemini 4 Neon',
    apiName: 'gemini-4-neon',
    contextWindow: 1048576,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: false,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'google-gemini-cli',
    name: 'Gemini 3.5 Flash',
    apiName: 'gemini-3.5-flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: false,
      supportsStreaming: false,
      supportsThinking: true
    }
  },
  {
    provider: 'google-gemini-cli',
    name: 'Gemini 3.1 Pro',
    apiName: 'gemini-3.1-pro',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: false,
      supportsStreaming: false,
      supportsThinking: true
    }
  }
].filter(model => Platform.isWin === !model.capabilities.supportsStreaming);
