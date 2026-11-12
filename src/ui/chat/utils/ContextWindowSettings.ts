/** Stable key for a user's context limit for one provider/model pair. */
export function getContextWindowOverrideKey(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

/** Keep a saved limit within the model's advertised context window. */
export function resolveContextWindowLimit(advertised: number, override?: number): number {
  if (!Number.isFinite(advertised) || advertised <= 0) return 0;
  const maximum = Math.floor(advertised);
  if (typeof override !== 'number' || !Number.isFinite(override) || override <= 0) return maximum;
  return Math.max(Math.min(1024, maximum), Math.min(maximum, Math.floor(override)));
}

/**
 * A chat budget saved at the model's whole window meant "use all of it", so it
 * follows the window when the window later grows (an OpenAI-compatible model
 * raised from its 4,096 fallback). A smaller budget was the user's choice and
 * stays, clamped to the current window.
 */
export function followRaisedContextWindow(budget: number, maximumWhenSaved: number | undefined, maximum: number): number {
  if (typeof maximumWhenSaved === 'number' && budget >= maximumWhenSaved
    && Number.isFinite(maximum) && maximum > budget) {
    return Math.floor(maximum);
  }
  return resolveContextWindowLimit(maximum, budget);
}
