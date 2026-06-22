import { ModelSpec } from '../modelTypes';

/**
 * Catalog of Gemini models exposed by the Antigravity CLI (`agy`) for the
 * `google-gemini-cli` provider.
 *
 * The `name` fields are the verbatim human labels emitted by `agy models` and
 * accepted by `agy --model` (see geminiCliModelNormalize.ts, which maps each
 * `apiName` slug below to its exact label). Keep this catalog and that allowlist
 * in LOCKSTEP — every `apiName` here must have a mapping there, or resolving the
 * model will throw fail-closed.
 *
 * Non-Gemini agy models (Claude Sonnet/Opus, GPT-OSS) are intentionally excluded
 * per product decision: this provider is Gemini-only.
 */
export const GOOGLE_GEMINI_CLI_MODELS: ModelSpec[] = [
  {
    provider: 'google-gemini-cli',
    name: 'Gemini 3.5 Flash (Low)',
    apiName: 'gemini-3.5-flash-low',
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
    name: 'Gemini 3.5 Flash (Medium)',
    apiName: 'gemini-3.5-flash-medium',
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
    name: 'Gemini 3.5 Flash (High)',
    apiName: 'gemini-3.5-flash-high',
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
    name: 'Gemini 3.1 Pro (Low)',
    apiName: 'gemini-3.1-pro-low',
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
    name: 'Gemini 3.1 Pro (High)',
    apiName: 'gemini-3.1-pro-high',
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
  }
];

export const GOOGLE_GEMINI_CLI_DEFAULT_MODEL = 'gemini-3.5-flash-medium';
