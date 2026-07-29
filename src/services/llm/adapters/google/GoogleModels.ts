/**
 * Google Model Specifications
 * Updated July 2026 — added Gemini 3.6 Flash and Gemini 3.5 Flash-Lite.
 */

import { ModelSpec } from '../modelTypes';

export const GOOGLE_MODELS: ModelSpec[] = [
  // Gemini 3.6 models
  {
    provider: 'google',
    name: 'Gemini 3.6 Flash',
    apiName: 'gemini-3.6-flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 1.50,
    outputCostPerMillion: 7.50,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Gemini 3.5 models
  {
    provider: 'google',
    name: 'Gemini 3.5 Flash',
    apiName: 'gemini-3.5-flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 1.50,
    outputCostPerMillion: 9.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'google',
    name: 'Gemini 3.5 Flash-Lite',
    apiName: 'gemini-3.5-flash-lite',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0.30,
    outputCostPerMillion: 2.50,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },

  // Gemini 3.1 models
  {
    provider: 'google',
    name: 'Gemini 3.1 Pro Preview',
    apiName: 'gemini-3.1-pro-preview',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 2.00,
    outputCostPerMillion: 12.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
];

export const GOOGLE_DEFAULT_MODEL = 'gemini-3.1-pro-preview';
