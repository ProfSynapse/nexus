/**
 * VisionMessageFormatter Unit Tests
 *
 * Tests the pure functions that format base64 PNG images
 * into provider-specific vision message formats.
 * Four provider families: OpenAI, Anthropic, Google, Ollama.
 */

import {
  getProviderFamily,
  formatVisionMessage,
} from '../../src/agents/ingestManager/tools/services/VisionMessageFormatter';
import { VisionProviderFamily } from '../../src/agents/ingestManager/types';

const SAMPLE_BASE64 = 'iVBORw0KGgoAAAANSUhEUg==';
const SAMPLE_PROMPT = 'Extract all text from this PDF page.';

describe('VisionMessageFormatter', () => {
  // ==========================================================================
  // getProviderFamily
  // ==========================================================================

  describe('getProviderFamily', () => {
    it.each([
      ['openai', 'openai'],
      ['openai-codex', 'openai'],
      ['github-copilot', 'openai'],
      ['groq', 'openai'],
      ['openrouter', 'openai'],
      ['mistral', 'openai'],
      ['requesty', 'openai'],
      ['lmstudio', 'openai'],
    ] as const)('should map "%s" to OpenAI family', (provider, expected) => {
      expect(getProviderFamily(provider)).toBe(expected);
    });

    it('should map "anthropic" to anthropic family', () => {
      expect(getProviderFamily('anthropic')).toBe('anthropic');
    });

    it('should map "anthropic-claude-code" to anthropic family', () => {
      expect(getProviderFamily('anthropic-claude-code')).toBe('anthropic');
    });

    it('should map "google" to google family', () => {
      expect(getProviderFamily('google')).toBe('google');
    });

    it('should map "google-gemini-cli" to google family', () => {
      expect(getProviderFamily('google-gemini-cli')).toBe('google');
    });

    it('should map "ollama" to ollama family', () => {
      expect(getProviderFamily('ollama')).toBe('ollama');
    });

    it('should default unknown providers to openai family', () => {
      expect(getProviderFamily('unknown-provider')).toBe('openai');
    });

    it('should default empty string to openai family', () => {
      expect(getProviderFamily('')).toBe('openai');
    });
  });

  // ==========================================================================
  // formatVisionMessage — OpenAI format
  // ==========================================================================

  describe('formatVisionMessage (openai)', () => {
    it('should return role "user"', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'openai');
      expect(msg.role).toBe('user');
    });

    it('should return content as an array with image_url and text parts', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'openai');
      const content = msg.content as unknown[];
      expect(Array.isArray(content)).toBe(true);
      expect(content).toHaveLength(2);
    });

    it('should format image_url with data: prefix', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'openai');
      const content = msg.content as { type: string; image_url?: { url: string }; text?: string }[];
      expect(content[0]).toEqual({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${SAMPLE_BASE64}` },
      });
    });

    it('should include the prompt as text part', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'openai');
      const content = msg.content as { type: string; text?: string }[];
      expect(content[1]).toEqual({
        type: 'text',
        text: SAMPLE_PROMPT,
      });
    });

    it('should not include images array on message', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'openai');
      expect(msg.images).toBeUndefined();
    });
  });

  // ==========================================================================
  // formatVisionMessage — Anthropic format
  // ==========================================================================

  describe('formatVisionMessage (anthropic)', () => {
    it('should return role "user"', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'anthropic');
      expect(msg.role).toBe('user');
    });

    it('should format image with source.type "base64" (no data: prefix)', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'anthropic');
      const content = msg.content as { type: string; source?: { type: string; media_type: string; data: string }; text?: string }[];
      expect(content[0]).toEqual({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: SAMPLE_BASE64,
        },
      });
    });

    it('should include text part', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'anthropic');
      const content = msg.content as { type: string; text?: string }[];
      expect(content[1]).toEqual({
        type: 'text',
        text: SAMPLE_PROMPT,
      });
    });

    it('should not include data: prefix in base64 data', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'anthropic');
      const content = msg.content as { source?: { data: string } }[];
      expect(content[0].source?.data).not.toContain('data:');
    });
  });

  // ==========================================================================
  // formatVisionMessage — Google format
  // ==========================================================================

  describe('formatVisionMessage (google)', () => {
    it('should return role "user"', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'google');
      expect(msg.role).toBe('user');
    });

    it('should format image with inline_data', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'google');
      const content = msg.content as { inline_data?: { mime_type: string; data: string }; text?: string }[];
      expect(content[0]).toEqual({
        inline_data: {
          mime_type: 'image/png',
          data: SAMPLE_BASE64,
        },
      });
    });

    it('should include text part (no type field)', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'google');
      const content = msg.content as { text?: string }[];
      expect(content[1]).toEqual({
        text: SAMPLE_PROMPT,
      });
    });

    it('should have content array of length 2', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'google');
      expect(msg.content).toHaveLength(2);
    });
  });

  // ==========================================================================
  // formatVisionMessage — Ollama format
  // ==========================================================================

  describe('formatVisionMessage (ollama)', () => {
    it('should return role "user"', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'ollama');
      expect(msg.role).toBe('user');
    });

    it('should set content as plain string (the prompt)', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'ollama');
      expect(msg.content).toBe(SAMPLE_PROMPT);
    });

    it('should set images array with raw base64 (no data: prefix)', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'ollama');
      expect(msg.images).toEqual([SAMPLE_BASE64]);
    });

    it('should have exactly one image in images array', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, 'ollama');
      expect(msg.images).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle empty base64 string', () => {
      const msg = formatVisionMessage('', SAMPLE_PROMPT, 'openai');
      const content = msg.content as { image_url?: { url: string } }[];
      expect(content[0].image_url?.url).toBe('data:image/png;base64,');
    });

    it('should handle empty prompt', () => {
      const msg = formatVisionMessage(SAMPLE_BASE64, '', 'anthropic');
      const content = msg.content as { text?: string }[];
      expect(content[1].text).toBe('');
    });

    it('should handle special characters in prompt', () => {
      const specialPrompt = 'Extract text: <html> & "quotes" \'single\'';
      const msg = formatVisionMessage(SAMPLE_BASE64, specialPrompt, 'openai');
      const content = msg.content as { text?: string }[];
      expect(content[1].text).toBe(specialPrompt);
    });

    it('should handle very long base64 strings', () => {
      const longBase64 = 'A'.repeat(100000);
      const msg = formatVisionMessage(longBase64, SAMPLE_PROMPT, 'ollama');
      expect(msg.images?.[0]).toBe(longBase64);
    });

    it('should produce consistent output for each provider family', () => {
      const families: VisionProviderFamily[] = ['openai', 'anthropic', 'google', 'ollama'];
      for (const family of families) {
        const msg1 = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, family);
        const msg2 = formatVisionMessage(SAMPLE_BASE64, SAMPLE_PROMPT, family);
        expect(msg1).toEqual(msg2);
      }
    });
  });
});
