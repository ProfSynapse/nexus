import { ModelSpec } from '../modelTypes';

/**
 * Base GitHub Copilot Models.
 *
 * At runtime the adapter queries the /models endpoint and Nexus prefers that
 * live list (see ProviderManager). This array is the FALLBACK shown before a
 * Copilot token is present and whenever discovery fails, so it must satisfy two
 * rules:
 *
 *   1. Every `apiName` is a real Copilot slug. A display name that advertises a
 *      newer model than the slug delivers is a lie to the user at exactly the
 *      moment discovery is unavailable, so name and slug must describe the same
 *      model.
 *   2. Context windows and capability flags describe the slug, not the model
 *      someone hoped to route to. Over-claiming a window produces requests the
 *      endpoint rejects; under-claiming only produces smaller requests.
 *
 * These are deliberately conservative, long-stable slugs. Refreshing this list
 * to Copilot's current line-up requires reading the live /models response --
 * do not guess slugs here.
 */
export const GITHUB_COPILOT_MODELS: ModelSpec[] = [
  {
    provider: 'github-copilot',
    name: 'GPT-4o (Copilot)',
    apiName: 'gpt-4o',
    contextWindow: 128000,
    maxTokens: 16384,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  },
  {
    provider: 'github-copilot',
    name: 'Claude 3.7 Sonnet (Copilot)',
    apiName: 'claude-3.7-sonnet',
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
    name: 'Gemini 2.0 Flash (Copilot)',
    apiName: 'gemini-2.0-flash-001',
    contextWindow: 1048576,
    maxTokens: 8192,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false
    }
  }
];

// Broadest-availability slug in the fallback list above: every Copilot tier
// serves it, so a user whose discovery has not run yet still gets a model that
// resolves. Live discovery replaces this as soon as a token is present.
export const GITHUB_COPILOT_DEFAULT_MODEL = 'gpt-4o';
