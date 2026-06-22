/**
 * tests/unit/TextOnlyProviderSeam.test.ts
 *
 * Verifies the single source of truth for the Antigravity (google-gemini-cli)
 * text-completion-only limitation:
 *  - the model catalog declares supportsFunctions:false + supportsStreaming:false
 *  - the provider seam (isTextOnlyProvider / shouldPassToolSchemasToProvider)
 *    classifies it as text-only and suppresses tool schemas.
 *
 * Background: agy tool-use + streaming proven NOT-FEASIBLE (investigation
 * #62/#64/#66). These guards keep the catalog honest and drive the user-facing
 * warning surfaces (settings notice + runtime guard).
 */
import { GOOGLE_GEMINI_CLI_MODELS } from '../../src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliModels';
import {
  isTextOnlyProvider,
  shouldPassToolSchemasToProvider,
  isPerplexityProvider
} from '../../src/services/llm/utils/ToolSchemaSupport';

describe('Antigravity text-only capability (SSOT)', () => {
  it('declares every agy model as no-tools, no-streaming', () => {
    expect(GOOGLE_GEMINI_CLI_MODELS.length).toBeGreaterThan(0);
    for (const model of GOOGLE_GEMINI_CLI_MODELS) {
      expect(model.provider).toBe('google-gemini-cli');
      expect(model.capabilities.supportsFunctions).toBe(false);
      expect(model.capabilities.supportsStreaming).toBe(false);
    }
  });
});

describe('text-only provider seam', () => {
  it('classifies google-gemini-cli (Antigravity) as text-only', () => {
    expect(isTextOnlyProvider('google-gemini-cli')).toBe(true);
  });

  it('classifies perplexity as text-only', () => {
    expect(isTextOnlyProvider('perplexity')).toBe(true);
  });

  it('does NOT classify webllm as text-only (tools are baked in)', () => {
    expect(isTextOnlyProvider('webllm')).toBe(false);
  });

  it('does NOT classify a normal cloud provider as text-only', () => {
    expect(isTextOnlyProvider('openai')).toBe(false);
    expect(isTextOnlyProvider(undefined)).toBe(false);
    expect(isTextOnlyProvider(null)).toBe(false);
  });

  it('suppresses tool schemas for Antigravity', () => {
    expect(shouldPassToolSchemasToProvider('google-gemini-cli')).toBe(false);
  });

  it('still passes tool schemas to a normal tool-capable provider', () => {
    expect(shouldPassToolSchemasToProvider('openai')).toBe(true);
  });

  it('keeps isPerplexityProvider perplexity-specific (not broadened)', () => {
    expect(isPerplexityProvider('perplexity')).toBe(true);
    expect(isPerplexityProvider('google-gemini-cli')).toBe(false);
  });
});
