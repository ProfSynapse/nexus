/**
 * The Context window slider snaps to a fixed set of sizes instead of moving one
 * token at a time. The stops are the presets strictly below the model's
 * maximum, followed by the maximum itself, so every model offers its full
 * window and small local models (under 32K) get a single stop.
 *
 * Storage is unchanged: `contextWindowOverrides[provider::model]` holds the
 * chosen size, and the maximum is stored as "no override". A saved size that is
 * not a stop (older settings, e.g. 150,000) keeps its value until the user
 * moves the slider; the thumb sits on the nearest stop below it.
 */

export const CONTEXT_WINDOW_PRESETS: readonly number[] = [
  32_000,
  64_000,
  128_000,
  200_000,
  350_000,
  750_000,
  1_000_000
];

/** Slider stops for a model whose window is `maximum` tokens, smallest first. */
export function contextWindowStops(maximum: number): number[] {
  if (!Number.isFinite(maximum) || maximum <= 0) return [];
  const max = Math.floor(maximum);
  return [...CONTEXT_WINDOW_PRESETS.filter(size => size < max), max];
}

/**
 * The slider index for a budget: the exact stop when there is one, otherwise
 * the nearest stop below it (the first stop when the budget is below them all).
 */
export function contextWindowStopIndex(stops: readonly number[], budget: number): number {
  let index = 0;
  for (let i = 0; i < stops.length; i++) {
    if (stops[i] <= budget) index = i;
  }
  return index;
}
