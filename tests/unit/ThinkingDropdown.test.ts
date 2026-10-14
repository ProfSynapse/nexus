/**
 * Thinking is one dropdown (Off, Low … Max) over the existing
 * `{ enabled, effort }` storage.
 *
 * Failures this buys: Off must not forget the stored effort (switching to Off
 * and back would otherwise reset the level), every level must round-trip, and
 * the row must not render for a model that cannot reason. Levels a model
 * folds onto a neighbour are hidden (owner decision 8), so two choices never
 * send the same request; with no capability data all six show.
 */
import {
  getThinkingLevels,
  optionToThinking,
  THINKING_LABELS,
  thinkingToOption
} from '../../src/components/shared/chatSettings/thinkingOptions';

it('maps Off to disabled and keeps the stored effort', () => {
  expect(optionToThinking('off', { enabled: true, effort: 'xhigh' })).toEqual({ enabled: false, effort: 'xhigh' });
  expect(thinkingToOption({ enabled: false, effort: 'xhigh' })).toBe('off');
});

it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('round-trips %s', level => {
  const state = optionToThinking(level, { enabled: false, effort: 'medium' });
  expect(state).toEqual({ enabled: true, effort: level });
  expect(thinkingToOption(state)).toBe(level);
});

const labels = (provider: string | undefined, model: string | undefined): string[] =>
  ['off', ...getThinkingLevels(provider, model)].map(option => THINKING_LABELS[option as keyof typeof THINKING_LABELS]);

it('labels every option and offers all six when there is no capability data', () => {
  expect(labels('anthropic', 'claude-opus-5-5')).toEqual(['Off', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  expect(labels('ollama', 'llama3')).toEqual(['Off', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  expect(labels(undefined, undefined)).toEqual(['Off', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
});

it('hides levels the model or provider does not distinguish', () => {
  // Claude Opus 4.6 treats Extra high as High.
  expect(labels('anthropic', 'claude-opus-4-6')).toEqual(['Off', 'Low', 'Medium', 'High', 'Max']);
  // Gemini stops at High.
  expect(labels('google', 'gemini-3.8-flash')).toEqual(['Off', 'Low', 'Medium', 'High']);
  // DeepSeek sends one of two levels.
  expect(labels('deepseek', 'deepseek-v4-pro-thinking')).toEqual(['Off', 'Medium', 'Max']);
});

it('shows a stored level the model folds away as the level really sent, without changing it', () => {
  const stored = { enabled: true, effort: 'xhigh' as const };
  expect(thinkingToOption(stored, 'anthropic', 'claude-opus-4-6')).toBe('high');
  expect(thinkingToOption(stored, 'google', 'gemini-3.8-flash')).toBe('high');
  expect(thinkingToOption(stored, 'anthropic', 'claude-opus-5-5')).toBe('xhigh');
  expect(stored).toEqual({ enabled: true, effort: 'xhigh' });
});

it('ignores an unknown option instead of inventing a level', () => {
  expect(optionToThinking('turbo', { enabled: true, effort: 'high' })).toEqual({ enabled: true, effort: 'high' });
  expect(thinkingToOption(undefined)).toBe('off');
});
