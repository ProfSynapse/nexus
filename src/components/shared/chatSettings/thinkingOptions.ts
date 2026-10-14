import type { ThinkingEffort } from '../../../types/llm/ProviderTypes';

/**
 * The Thinking dropdown: Off plus one entry per effort level. It reads and
 * writes the existing `{ enabled, effort }` storage, so nothing migrates:
 * Off keeps the stored effort and only clears `enabled`.
 */

export type ThinkingOption = 'off' | ThinkingEffort;

export interface ThinkingState {
  enabled: boolean;
  effort: ThinkingEffort;
}

export const THINKING_LEVELS: readonly ThinkingEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const THINKING_LABELS: Record<ThinkingOption, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
};

/**
 * Levels offered for a model. Every level today; capability-driven filtering
 * (hide levels a model or provider does not support) plugs in here.
 */
export function getThinkingLevels(_provider: string | undefined, _model: string | undefined): ThinkingEffort[] {
  return [...THINKING_LEVELS];
}

export function thinkingToOption(thinking: ThinkingState | undefined): ThinkingOption {
  if (!thinking?.enabled) return 'off';
  return thinking.effort;
}

export function optionToThinking(option: string, current: ThinkingState | undefined): ThinkingState {
  const effort = current?.effort ?? 'medium';
  if (option === 'off') return { enabled: false, effort };
  if ((THINKING_LEVELS as readonly string[]).includes(option)) {
    return { enabled: true, effort: option as ThinkingEffort };
  }
  return { enabled: current?.enabled ?? false, effort };
}
