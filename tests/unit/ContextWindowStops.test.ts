/**
 * The Context window slider's stops: the presets strictly below the model's
 * maximum, then the maximum. Failures this buys: a preset above the model's
 * limit being offered (a budget the model cannot honour), the maximum missing
 * (no way back to the full window), a duplicate stop when the maximum is
 * itself a preset, and a saved size between stops snapping upward.
 */
import {
  CONTEXT_WINDOW_PRESETS,
  contextWindowStopIndex,
  contextWindowStops
} from '../../src/components/shared/chatSettings/contextWindowStops';

it('offers every preset for a 1M model, ending at 1M', () => {
  expect(contextWindowStops(1_000_000)).toEqual([32_000, 64_000, 128_000, 200_000, 350_000, 750_000, 1_000_000]);
  expect(contextWindowStops(1_000_000)).toEqual([...CONTEXT_WINDOW_PRESETS]);
});

it('drops presets at or above the maximum and ends at the maximum', () => {
  expect(contextWindowStops(200_000)).toEqual([32_000, 64_000, 128_000, 200_000]);
  expect(contextWindowStops(40_000)).toEqual([32_000, 40_000]);
  expect(contextWindowStops(1_050_000)).toEqual([...CONTEXT_WINDOW_PRESETS, 1_050_000]);
});

it('gives a model below every preset a single stop', () => {
  expect(contextWindowStops(4096)).toEqual([4096]);
});

it('has no stops without a window', () => {
  expect(contextWindowStops(0)).toEqual([]);
  expect(contextWindowStops(Number.NaN)).toEqual([]);
});

it('puts a saved size on its stop, or on the nearest stop below', () => {
  const stops = contextWindowStops(1_000_000);
  expect(contextWindowStopIndex(stops, 200_000)).toBe(3);
  expect(contextWindowStopIndex(stops, 150_000)).toBe(2);
  expect(contextWindowStopIndex(stops, 1_000_000)).toBe(6);
  expect(contextWindowStopIndex(stops, 10_000)).toBe(0);
});
