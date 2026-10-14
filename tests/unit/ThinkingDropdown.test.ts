/**
 * Thinking is one dropdown (Off, Low … Max) over the existing
 * `{ enabled, effort }` storage.
 *
 * Failures this buys: Off must not forget the stored effort (switching to Off
 * and back would otherwise reset the level), every level must round-trip, and
 * the row must not render for a model that cannot reason.
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

it('labels every option and offers all levels when nothing narrows them', () => {
  expect(['off', ...getThinkingLevels('anthropic', 'claude-opus-4-6')].map(option => THINKING_LABELS[option as keyof typeof THINKING_LABELS]))
    .toEqual(['Off', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
});

it('ignores an unknown option instead of inventing a level', () => {
  expect(optionToThinking('turbo', { enabled: true, effort: 'high' })).toEqual({ enabled: true, effort: 'high' });
  expect(thinkingToOption(undefined)).toBe('off');
});
