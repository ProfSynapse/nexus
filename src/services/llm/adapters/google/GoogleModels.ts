/**
 * Google Model Specifications
 * Updated February 19, 2026 with Gemini 3.1 Pro Preview
 */

import { ModelSpec } from '../modelTypes';

export const GOOGLE_MODELS: ModelSpec[] = [
  // Gemini 3.1 models (latest)
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

  // Gemini 3.0 models
  {
    provider: 'google',
    name: 'Gemini 3.0 Pro Preview',
    apiName: 'gemini-3-pro-preview',
    contextWindow: 1048576,
    maxTokens: 8192,
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
  {
    provider: 'google',
    name: 'Gemini 3.0 Flash Preview',
    apiName: 'gemini-3-flash-preview',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0.50,
    outputCostPerMillion: 3.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  // Gemini 2.5 models
  {
    provider: 'google',
    name: 'Gemini 2.5 Pro',
    apiName: 'gemini-2.5-pro',
    contextWindow: 2000000,
    maxTokens: 8192,
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 10.00,
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
    name: 'Gemini 2.5 Flash',
    apiName: 'gemini-2.5-flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.60,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true  // Updated: 2.5 Flash now supports thinking mode
    }
  }
];

export const GOOGLE_DEFAULT_MODEL = 'gemini-3-pro-preview';