import { Platform } from 'obsidian';
import { GOOGLE_GEMINI_CLI_MODELS } from '../../src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliModels';
import {
  isTextOnlyProvider,
  shouldPassToolSchemasToProvider,
  isPerplexityProvider
} from '../../src/services/llm/utils/ToolSchemaSupport';

describe('Antigravity ACP capabilities', () => {
  it('declares every ACP model as supporting tools and streaming', () => {
    expect(GOOGLE_GEMINI_CLI_MODELS.length).toBeGreaterThan(0);
    for (const model of GOOGLE_GEMINI_CLI_MODELS) {
      expect(model.provider).toBe('google-gemini-cli');
      expect(model.capabilities.supportsFunctions).toBe(true);
      expect(model.capabilities.supportsStreaming).toBe(true);
    }
  });
});

describe('text-only provider seam', () => {
  it('classifies Antigravity as text-only only on Windows', () => {
    expect(isTextOnlyProvider('google-gemini-cli')).toBe(false);
    expect(shouldPassToolSchemasToProvider('google-gemini-cli')).toBe(true);
    const win = jest.replaceProperty(Platform, 'isWin', true);
    try {
      expect(isTextOnlyProvider('google-gemini-cli')).toBe(true);
      expect(shouldPassToolSchemasToProvider('google-gemini-cli')).toBe(false);
    } finally {
      win.restore();
    }
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

  it('still passes tool schemas to a normal tool-capable provider', () => {
    expect(shouldPassToolSchemasToProvider('openai')).toBe(true);
  });

  it('keeps isPerplexityProvider perplexity-specific (not broadened)', () => {
    expect(isPerplexityProvider('perplexity')).toBe(true);
    expect(isPerplexityProvider('google-gemini-cli')).toBe(false);
  });
});
