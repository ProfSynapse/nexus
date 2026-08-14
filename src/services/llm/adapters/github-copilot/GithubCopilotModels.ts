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
 * KNOWN GAP: every slug below is an older Copilot model. This list has not been
 * refreshed against Copilot's current line-up, and the current slugs cannot be
 * derived offline — they have to be read from the live /models response, which
 * is also what replaces this list as soon as a token is present. Refresh it from
 * that response rather than guessing slugs here.
 */
export const GITHUB_COPILOT_MODELS: ModelSpec[] = [
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

// STOPGAP. The previous value ('gpt-5.4') named no entry here at all, so it
// resolved to nothing. This is the most capable general-purpose slug currently
// in the fallback list — it is still an old model, and it is the right default
// only until the list above is refreshed from the live /models response.
// Trade-off to be aware of: Claude models require a Copilot plan that includes
// them, so on a restricted plan the GPT slug is the safer fallback.
export const GITHUB_COPILOT_DEFAULT_MODEL = 'claude-3.7-sonnet';
