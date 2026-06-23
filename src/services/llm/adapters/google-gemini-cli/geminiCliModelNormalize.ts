/**
 * src/services/llm/adapters/google-gemini-cli/geminiCliModelNormalize.ts
 *
 * Composes the human-label model name the Antigravity CLI (`agy`) expects on
 * `--model` from a Nexus BASE model slug + the thinking/effort SLIDER value.
 *
 * Why this exists: `agy --model` FAILS OPEN — given an unknown value it does NOT
 * error, it silently runs a default model and returns exit 0. If Nexus passed a
 * slug (e.g. `gemini-3.5-flash`) or a malformed label straight through, the user
 * would get a different model than they selected with no signal. So this module
 * is a FAIL-CLOSED resolver: the base must be a known base model and the composed
 * "Base (Effort)" label must be in the known agy label set, otherwise we throw a
 * clear error rather than let agy pick something arbitrary.
 *
 * Effort source: the catalog lists only the 2 BASE models (no -low/-medium/-high
 * entries). Effort comes from the slider (`options.thinkingEffort`) at invocation
 * time. Legacy effort-variant slugs and older `*-preview` slugs are still accepted
 * (settings-compat): they carry an EXPLICIT effort that overrides the slider, so a
 * user's saved selection still resolves to the model+effort they chose.
 *
 * agy effort matrix (`agy models`, verified live):
 *   - Gemini 3.5 Flash → Low / Medium / High
 *   - Gemini 3.1 Pro   → Low / High        (NO Medium)
 * Clamp rule (team-lead ruling, task #75): a requested Medium on a base that lacks
 * Medium (Pro) clamps UP to the nearest available (High) — never silently DOWN, so
 * we never give less reasoning than the user asked for. Pro thus defaults to High
 * when the slider is untouched (effort defaults to 'medium' → clamps to High); this
 * is a deliberate, ruled choice (premium model, capability-by-default).
 *
 * Used by: GoogleGeminiCliAdapter.generateUncached, at the point the model string
 * + effort are resolved (before the composed label is placed into the agy
 * `--model` argument).
 */
import { LLMProviderError } from '../types';

const PROVIDER_NAME = 'google-gemini-cli';

export type AgyEffort = 'low' | 'medium' | 'high';

/** Default effort when the slider is untouched / thinking is off (mirrors GoogleAdapter). */
const DEFAULT_EFFORT: AgyEffort = 'medium';

/**
 * Base model slug → its verbatim `agy models` base label + the effort levels that
 * base supports. The composed `--model` label is `"<baseLabel> (<Effort>)"`.
 */
interface BaseModelSpec {
  readonly baseLabel: string;
  readonly supportedEfforts: ReadonlySet<AgyEffort>;
}

const BASE_MODELS: Readonly<Record<string, BaseModelSpec>> = Object.freeze({
  'gemini-3.5-flash': {
    baseLabel: 'Gemini 3.5 Flash',
    supportedEfforts: new Set<AgyEffort>(['low', 'medium', 'high'])
  },
  'gemini-3.1-pro': {
    baseLabel: 'Gemini 3.1 Pro',
    supportedEfforts: new Set<AgyEffort>(['low', 'high'])
  }
});

/**
 * Legacy slug → (base slug, EXPLICIT effort). These are saved selections from
 * earlier builds that must still resolve. The explicit effort here OVERRIDES the
 * slider, preserving exactly what the user picked.
 *  - the 5 effort-variant slugs shipped this branch
 *  - the older `*-preview` slugs that predate the effort-variant catalog
 */
const LEGACY_SLUG_TO_BASE_EFFORT: Readonly<Record<string, { base: string; effort: AgyEffort }>> = Object.freeze({
  // Effort-variant slugs (this branch).
  'gemini-3.5-flash-low': { base: 'gemini-3.5-flash', effort: 'low' },
  'gemini-3.5-flash-medium': { base: 'gemini-3.5-flash', effort: 'medium' },
  'gemini-3.5-flash-high': { base: 'gemini-3.5-flash', effort: 'high' },
  'gemini-3.1-pro-low': { base: 'gemini-3.1-pro', effort: 'low' },
  'gemini-3.1-pro-high': { base: 'gemini-3.1-pro', effort: 'high' },

  // Older preview slugs (pre-effort-variant catalog).
  'gemini-3-flash-preview': { base: 'gemini-3.5-flash', effort: 'medium' },
  'gemini-3.1-flash-lite-preview': { base: 'gemini-3.5-flash', effort: 'low' }
});

/** Title-case effort for the agy parenthetical (low → Low). */
function effortToLabel(effort: AgyEffort): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** The set of fully-composed agy labels we knowingly support (every base × its supported efforts). */
const KNOWN_AGY_LABELS: ReadonlySet<string> = new Set(
  Object.values(BASE_MODELS).flatMap((spec) =>
    [...spec.supportedEfforts].map((effort) => `${spec.baseLabel} (${effortToLabel(effort)})`)
  )
);

function isAgyEffort(value: unknown): value is AgyEffort {
  return value === 'low' || value === 'medium' || value === 'high';
}

/**
 * Clamp a requested effort to the nearest available level on a base model, rounding
 * UP (never down) per the team-lead ruling. Today the only gap is Pro's missing
 * Medium → High; the candidate order generalizes to any future asymmetry.
 */
function clampEffort(requested: AgyEffort, supported: ReadonlySet<AgyEffort>): AgyEffort {
  if (supported.has(requested)) {
    return requested;
  }
  // Prefer rounding UP (more reasoning); fall back to rounding down only if needed.
  const preference: AgyEffort[] = requested === 'low'
    ? ['low', 'medium', 'high']
    : requested === 'medium'
      ? ['high', 'low'] // Medium unavailable → prefer High over Low (never silently less).
      : ['high', 'medium', 'low'];
  for (const candidate of preference) {
    if (supported.has(candidate)) {
      return candidate;
    }
  }
  // Unreachable for the current matrix (every base supports at least one effort).
  throw new LLMProviderError(
    'No supported effort level for the Antigravity CLI base model.',
    PROVIDER_NAME,
    'CONFIGURATION_ERROR'
  );
}

/** Compose + clamp + validate a (base slug, effort) pair into the final agy label. */
function composeFromBase(baseSlug: string, effort: AgyEffort): string {
  const spec = BASE_MODELS[baseSlug];
  if (!spec) {
    throw new LLMProviderError(
      `Base model "${baseSlug}" is not supported by the Antigravity CLI provider.`,
      PROVIDER_NAME,
      'CONFIGURATION_ERROR'
    );
  }

  const resolvedEffort = clampEffort(effort, spec.supportedEfforts);
  const label = `${spec.baseLabel} (${effortToLabel(resolvedEffort)})`;

  // Defense-in-depth: the composed label goes into argv (Windows .cmd metachar
  // sink). It is built only from the frozen base label + a fixed effort word, but
  // re-validate against the known set so a future edit can't leak an arbitrary
  // string into the command line.
  if (!KNOWN_AGY_LABELS.has(label)) {
    throw new LLMProviderError(
      `Composed Antigravity model label "${label}" is not in the supported set.`,
      PROVIDER_NAME,
      'CONFIGURATION_ERROR'
    );
  }

  return label;
}

/**
 * Resolve a Nexus model identifier + slider effort to the agy `--model` label,
 * fail-closed.
 *
 * Accepts:
 *  - a BASE slug (`gemini-3.5-flash`, `gemini-3.1-pro`) → effort from `sliderEffort`
 *  - a LEGACY slug (effort-variant or preview) → its explicit effort (overrides slider)
 *  - an already-composed agy label (e.g. `Gemini 3.5 Flash (High)`) → idempotent pass-through
 *
 * Any other value throws — agy would otherwise silently default, masking the
 * mismatch. The composed label is allowlist-validated before it can reach argv
 * (Windows `.cmd` metachar sink defense).
 *
 * @param model - the model identifier resolved by the adapter (base slug, legacy slug, or agy label)
 * @param sliderEffort - the thinking/effort slider value (`options.thinkingEffort`); undefined → default
 * @returns the verbatim agy human label to pass to `--model`
 * @throws LLMProviderError when the model is missing or not in the allowlist
 */
export function composeAgyModelLabel(
  model: string | undefined | null,
  sliderEffort?: string | null
): string {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (!trimmed) {
    throw new LLMProviderError(
      'No model was specified for the Antigravity CLI provider.',
      PROVIDER_NAME,
      'CONFIGURATION_ERROR'
    );
  }

  // Already a composed agy label — allow idempotent pass-through.
  if (KNOWN_AGY_LABELS.has(trimmed)) {
    return trimmed;
  }

  // Legacy slug: explicit effort overrides the slider.
  const legacy = LEGACY_SLUG_TO_BASE_EFFORT[trimmed];
  if (legacy) {
    return composeFromBase(legacy.base, legacy.effort);
  }

  // Base slug: effort comes from the slider (default when unset).
  if (BASE_MODELS[trimmed]) {
    const effort = isAgyEffort(sliderEffort) ? sliderEffort : DEFAULT_EFFORT;
    return composeFromBase(trimmed, effort);
  }

  throw new LLMProviderError(
    `Model "${trimmed}" is not supported by the Antigravity CLI provider. ` +
      `Supported base models: ${Object.keys(BASE_MODELS).join(', ')}.`,
    PROVIDER_NAME,
    'CONFIGURATION_ERROR'
  );
}
