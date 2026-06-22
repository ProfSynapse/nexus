import { normalizeModelToAgyLabel } from '../../src/services/llm/adapters/google-gemini-cli/geminiCliModelNormalize';

/**
 * Direct unit tests for the fail-closed model-label allowlist.
 *
 * Why fail-closed matters: `agy --model` FAILS OPEN — given an unknown value it
 * silently runs a default model and returns exit 0. So Nexus must reject any
 * slug not in the allowlist BEFORE spawning, or the user silently gets a model
 * they did not select. These tests pin both the mapping fidelity and the
 * rejection behavior.
 */
describe('normalizeModelToAgyLabel (fail-closed agy model allowlist)', () => {
  describe('current catalog slug → agy label mapping (refreshed 5-entry catalog)', () => {
    // Mirrors GoogleGeminiCliModels.ts + the SLUG_TO_AGY_LABEL current group;
    // every shipped catalog slug must resolve to its verbatim agy label.
    it.each([
      ['gemini-3.5-flash-low', 'Gemini 3.5 Flash (Low)'],
      ['gemini-3.5-flash-medium', 'Gemini 3.5 Flash (Medium)'],
      ['gemini-3.5-flash-high', 'Gemini 3.5 Flash (High)'],
      ['gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)'],
      ['gemini-3.1-pro-high', 'Gemini 3.1 Pro (High)']
    ])('maps %s to %s', (slug, label) => {
      expect(normalizeModelToAgyLabel(slug)).toBe(label);
    });
  });

  describe('legacy slug → agy label mapping (settings-compat aliases retained)', () => {
    it('maps gemini-3-flash-preview to its agy label', () => {
      expect(normalizeModelToAgyLabel('gemini-3-flash-preview')).toBe('Gemini 3.5 Flash (Medium)');
    });

    it('maps gemini-3.1-flash-lite-preview to its agy label', () => {
      expect(normalizeModelToAgyLabel('gemini-3.1-flash-lite-preview')).toBe('Gemini 3.5 Flash (Low)');
    });

    it('trims surrounding whitespace before mapping', () => {
      expect(normalizeModelToAgyLabel('  gemini-3-flash-preview  ')).toBe('Gemini 3.5 Flash (Medium)');
    });
  });

  describe('idempotent pass-through of already-normalized labels', () => {
    it('returns a known agy label unchanged', () => {
      expect(normalizeModelToAgyLabel('Gemini 3.5 Flash (Medium)')).toBe('Gemini 3.5 Flash (Medium)');
      expect(normalizeModelToAgyLabel('Gemini 3.5 Flash (Low)')).toBe('Gemini 3.5 Flash (Low)');
      expect(normalizeModelToAgyLabel('Gemini 3.1 Pro (High)')).toBe('Gemini 3.1 Pro (High)');
    });
  });

  describe('fail-closed rejections (CONFIGURATION_ERROR before any spawn)', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['empty string', ''],
      ['whitespace only', '   ']
    ])('throws when the model is %s', (_label, value) => {
      expect(() => normalizeModelToAgyLabel(value as string | undefined | null)).toThrow();
      try {
        normalizeModelToAgyLabel(value as string | undefined | null);
      } catch (err) {
        expect(err).toMatchObject({
          name: 'LLMProviderError',
          provider: 'google-gemini-cli',
          code: 'CONFIGURATION_ERROR'
        });
      }
    });

    it('throws for an unknown/unmapped slug — never silently defaults', () => {
      expect(() => normalizeModelToAgyLabel('not-a-real-model')).toThrow();
      try {
        normalizeModelToAgyLabel('not-a-real-model');
      } catch (err) {
        expect(err).toMatchObject({
          name: 'LLMProviderError',
          provider: 'google-gemini-cli',
          code: 'CONFIGURATION_ERROR'
        });
        // The error names the supported models so the user can recover.
        expect((err as Error).message).toContain('Gemini 3.5 Flash (Medium)');
        expect((err as Error).message).toContain('Gemini 3.5 Flash (Low)');
      }
    });

    it('rejects a legacy gemini slug that has no allowlist entry (e.g. a 2.5 spec)', () => {
      // Guards against a future GoogleGeminiCliModels.ts spec being added without
      // a matching allowlist entry — it must throw, not pass through.
      expect(() => normalizeModelToAgyLabel('gemini-2.5-pro')).toThrow();
    });
  });

  describe('live-fidelity anchor (auditor YELLOW carry-forward)', () => {
    /**
     * These five labels were live-verified against `agy models` (v1.0.10) on
     * 2026-06-22: each appears VERBATIM in the real agy catalog. This anchor
     * fails loudly if a future edit drifts a mapping target away from the real
     * agy label — a mismatch would make `agy --model` fail open and silently
     * run the wrong model.
     *
     * Live `agy models` output included, verbatim (Gemini lines):
     *   Gemini 3.5 Flash (Medium)
     *   Gemini 3.5 Flash (High)
     *   Gemini 3.5 Flash (Low)
     *   Gemini 3.1 Pro (Low)
     *   Gemini 3.1 Pro (High)
     */
    it('pins the current catalog slugs to their verbatim live agy catalog labels', () => {
      expect(normalizeModelToAgyLabel('gemini-3.5-flash-low')).toBe('Gemini 3.5 Flash (Low)');
      expect(normalizeModelToAgyLabel('gemini-3.5-flash-medium')).toBe('Gemini 3.5 Flash (Medium)');
      expect(normalizeModelToAgyLabel('gemini-3.5-flash-high')).toBe('Gemini 3.5 Flash (High)');
      expect(normalizeModelToAgyLabel('gemini-3.1-pro-low')).toBe('Gemini 3.1 Pro (Low)');
      expect(normalizeModelToAgyLabel('gemini-3.1-pro-high')).toBe('Gemini 3.1 Pro (High)');
    });

    it('still resolves the retained legacy aliases (settings-compat)', () => {
      expect(normalizeModelToAgyLabel('gemini-3-flash-preview')).toBe('Gemini 3.5 Flash (Medium)');
      expect(normalizeModelToAgyLabel('gemini-3.1-flash-lite-preview')).toBe('Gemini 3.5 Flash (Low)');
    });
  });
});
