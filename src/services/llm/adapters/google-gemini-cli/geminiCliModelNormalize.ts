/**
 * src/services/llm/adapters/google-gemini-cli/geminiCliModelNormalize.ts
 *
 * Maps Nexus's legacy `google-gemini-cli` model slugs (see GoogleGeminiCliModels.ts)
 * to the human-label model names the Antigravity CLI (`agy`) expects on `--model`.
 *
 * Why this exists: `agy --model` FAILS OPEN — given an unknown value it does NOT
 * error, it silently runs a default model and returns exit 0. If Nexus passed a
 * legacy slug (e.g. `gemini-3-flash-preview`) straight through, the user would get
 * a different model than they selected with no signal. So this module is a
 * FAIL-CLOSED allowlist: a slug must be explicitly mapped, otherwise we throw a
 * clear error rather than let agy pick something arbitrary.
 *
 * Used by: GoogleGeminiCliAdapter.generateUncached, at the point the model string
 * is resolved (before it is placed into the agy `--model` argument).
 */
import { LLMProviderError } from '../types';

const PROVIDER_NAME = 'google-gemini-cli';

/**
 * Allowlist mapping legacy Nexus model slugs → the verbatim `agy models` human
 * labels accepted by `agy --model`. Keep entries in sync with
 * GoogleGeminiCliModels.ts; an entry must exist here for every shipped spec, or
 * resolving that model will throw.
 */
const LEGACY_SLUG_TO_AGY_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'gemini-3-flash-preview': 'Gemini 3.5 Flash (Medium)',
  'gemini-3.1-flash-lite-preview': 'Gemini 3.5 Flash (Low)'
});

/**
 * The set of agy labels we knowingly support (the values of the allowlist). An
 * already-mapped agy label is allowed to pass through unchanged so callers can
 * be idempotent without re-mapping.
 */
const KNOWN_AGY_LABELS: ReadonlySet<string> = new Set(Object.values(LEGACY_SLUG_TO_AGY_LABEL));

/**
 * Resolve a Nexus model identifier to the agy `--model` label, fail-closed.
 *
 * Accepts either a legacy Nexus slug (mapped via the allowlist) or an already
 * normalized agy label (passed through). Any other value throws an
 * LLMProviderError — agy would otherwise silently default, masking the mismatch.
 *
 * @param model - the model identifier resolved by the adapter (legacy slug or agy label)
 * @returns the verbatim agy human label to pass to `--model`
 * @throws LLMProviderError when the model is missing or not in the allowlist
 */
export function normalizeModelToAgyLabel(model: string | undefined | null): string {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (!trimmed) {
    throw new LLMProviderError(
      'No model was specified for the Antigravity CLI provider.',
      PROVIDER_NAME,
      'CONFIGURATION_ERROR'
    );
  }

  const mapped = LEGACY_SLUG_TO_AGY_LABEL[trimmed];
  if (mapped) {
    return mapped;
  }

  // Already an agy label — allow idempotent pass-through.
  if (KNOWN_AGY_LABELS.has(trimmed)) {
    return trimmed;
  }

  throw new LLMProviderError(
    `Model "${trimmed}" is not supported by the Antigravity CLI provider. ` +
      `Supported models: ${[...KNOWN_AGY_LABELS].join(', ')}.`,
    PROVIDER_NAME,
    'CONFIGURATION_ERROR'
  );
}
