import { composeAgyModelLabel } from '../../src/services/llm/adapters/google-gemini-cli/geminiCliModelNormalize';

/**
 * Direct unit tests for the fail-closed agy `--model` label composer.
 *
 * The catalog now lists only the 2 BASE models; effort comes from the thinking/
 * effort slider, and the adapter composes the "Base (Effort)" agy label at
 * invocation. These tests pin: base+effort composition, the Pro-no-Medium clamp
 * (Medium → High, round UP), default-effort behavior, legacy-slug explicit-effort
 * resolution (settings-compat), idempotent pass-through, and fail-closed rejection.
 *
 * Why fail-closed matters: `agy --model` FAILS OPEN — given an unknown value it
 * silently runs a default model and returns exit 0. So Nexus must reject any
 * unknown base / malformed composed label BEFORE spawning.
 */
describe('composeAgyModelLabel (fail-closed agy label composition)', () => {
  describe('base slug + slider effort → composed agy label', () => {
    it.each([
      ['gemini-3.5-flash', 'low', 'Gemini 3.5 Flash (Low)'],
      ['gemini-3.5-flash', 'medium', 'Gemini 3.5 Flash (Medium)'],
      ['gemini-3.5-flash', 'high', 'Gemini 3.5 Flash (High)'],
      ['gemini-3.1-pro', 'low', 'Gemini 3.1 Pro (Low)'],
      ['gemini-3.1-pro', 'high', 'Gemini 3.1 Pro (High)']
    ])('composes %s @ %s → %s', (slug, effort, label) => {
      expect(composeAgyModelLabel(slug, effort)).toBe(label);
    });
  });

  describe('Pro-no-Medium clamp rule (Medium → High, round UP, never down)', () => {
    it('clamps Gemini 3.1 Pro + Medium up to High', () => {
      expect(composeAgyModelLabel('gemini-3.1-pro', 'medium')).toBe('Gemini 3.1 Pro (High)');
    });

    it('does NOT clamp Flash (it natively supports Medium)', () => {
      expect(composeAgyModelLabel('gemini-3.5-flash', 'medium')).toBe('Gemini 3.5 Flash (Medium)');
    });
  });

  describe('default effort when slider is unset (undefined/invalid → medium, then clamp)', () => {
    it('Flash defaults to Medium', () => {
      expect(composeAgyModelLabel('gemini-3.5-flash')).toBe('Gemini 3.5 Flash (Medium)');
      expect(composeAgyModelLabel('gemini-3.5-flash', undefined)).toBe('Gemini 3.5 Flash (Medium)');
      expect(composeAgyModelLabel('gemini-3.5-flash', null)).toBe('Gemini 3.5 Flash (Medium)');
    });

    it('Pro defaults to High (deliberate: default medium clamps up on Pro)', () => {
      expect(composeAgyModelLabel('gemini-3.1-pro')).toBe('Gemini 3.1 Pro (High)');
      expect(composeAgyModelLabel('gemini-3.1-pro', undefined)).toBe('Gemini 3.1 Pro (High)');
    });

    it('treats an unrecognized effort string as default (medium)', () => {
      expect(composeAgyModelLabel('gemini-3.5-flash', 'bogus')).toBe('Gemini 3.5 Flash (Medium)');
    });
  });

  describe('legacy slug → (base, EXPLICIT effort) settings-compat (overrides slider)', () => {
    it.each([
      ['gemini-3.5-flash-low', 'Gemini 3.5 Flash (Low)'],
      ['gemini-3.5-flash-medium', 'Gemini 3.5 Flash (Medium)'],
      ['gemini-3.5-flash-high', 'Gemini 3.5 Flash (High)'],
      ['gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)'],
      ['gemini-3.1-pro-high', 'Gemini 3.1 Pro (High)'],
      // Older preview slugs.
      ['gemini-3-flash-preview', 'Gemini 3.5 Flash (Medium)'],
      ['gemini-3.1-flash-lite-preview', 'Gemini 3.5 Flash (Low)']
    ])('resolves legacy %s → %s regardless of slider', (slug, label) => {
      // Pass a conflicting slider effort to prove the legacy explicit effort wins.
      expect(composeAgyModelLabel(slug, 'low')).toBe(label);
    });

    it('trims surrounding whitespace before resolving', () => {
      expect(composeAgyModelLabel('  gemini-3.5-flash-high  ', 'low')).toBe('Gemini 3.5 Flash (High)');
    });
  });

  describe('idempotent pass-through of already-composed labels', () => {
    it('returns a known agy label unchanged', () => {
      expect(composeAgyModelLabel('Gemini 3.5 Flash (Medium)')).toBe('Gemini 3.5 Flash (Medium)');
      expect(composeAgyModelLabel('Gemini 3.5 Flash (Low)', 'high')).toBe('Gemini 3.5 Flash (Low)');
      expect(composeAgyModelLabel('Gemini 3.1 Pro (High)')).toBe('Gemini 3.1 Pro (High)');
    });
  });

  describe('fail-closed rejections (CONFIGURATION_ERROR before any spawn)', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['empty string', ''],
      ['whitespace only', '   ']
    ])('throws when the model is %s', (_label, value) => {
      expect(() => composeAgyModelLabel(value as string | undefined | null)).toThrow();
      try {
        composeAgyModelLabel(value as string | undefined | null);
      } catch (err) {
        expect(err).toMatchObject({
          name: 'LLMProviderError',
          provider: 'google-gemini-cli',
          code: 'CONFIGURATION_ERROR'
        });
      }
    });

    it('throws for an unknown base slug — never silently defaults', () => {
      expect(() => composeAgyModelLabel('not-a-real-model', 'high')).toThrow();
      try {
        composeAgyModelLabel('not-a-real-model', 'high');
      } catch (err) {
        expect(err).toMatchObject({
          name: 'LLMProviderError',
          provider: 'google-gemini-cli',
          code: 'CONFIGURATION_ERROR'
        });
        // The error names the supported BASE models so the user can recover.
        expect((err as Error).message).toContain('gemini-3.5-flash');
        expect((err as Error).message).toContain('gemini-3.1-pro');
      }
    });

    it('rejects a non-allowlisted gemini base (e.g. a 2.5 spec)', () => {
      expect(() => composeAgyModelLabel('gemini-2.5-pro', 'high')).toThrow();
    });

    it('rejects a Pro composed label that does not exist (Pro Medium is not a valid pass-through)', () => {
      // 'Gemini 3.1 Pro (Medium)' is NOT a known agy label, so passing it through
      // must NOT silently succeed — it falls through to the unknown-model throw.
      expect(() => composeAgyModelLabel('Gemini 3.1 Pro (Medium)')).toThrow();
    });
  });

  describe('live-fidelity anchor (verified vs `agy models`)', () => {
    /**
     * Composed labels verified VERBATIM against `agy models` (v1.0.10) on
     * 2026-06-23: Flash = Low/Medium/High; Pro = Low/High (NO Medium). This anchor
     * fails loudly if a future edit drifts a composed label away from a real agy
     * label — a mismatch would make `agy --model` fail open.
     */
    it('every composed base+effort matches a live agy label', () => {
      expect(composeAgyModelLabel('gemini-3.5-flash', 'low')).toBe('Gemini 3.5 Flash (Low)');
      expect(composeAgyModelLabel('gemini-3.5-flash', 'medium')).toBe('Gemini 3.5 Flash (Medium)');
      expect(composeAgyModelLabel('gemini-3.5-flash', 'high')).toBe('Gemini 3.5 Flash (High)');
      expect(composeAgyModelLabel('gemini-3.1-pro', 'low')).toBe('Gemini 3.1 Pro (Low)');
      expect(composeAgyModelLabel('gemini-3.1-pro', 'high')).toBe('Gemini 3.1 Pro (High)');
      // Pro Medium is NOT a live label → must clamp to the live High label.
      expect(composeAgyModelLabel('gemini-3.1-pro', 'medium')).toBe('Gemini 3.1 Pro (High)');
    });
  });
});
