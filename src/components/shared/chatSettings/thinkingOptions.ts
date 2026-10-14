import type { ThinkingEffort } from '../../../types/llm/ProviderTypes';
import {
  getSupportedThinkingEfforts,
  normalizeThinkingEffortForModel
} from '../../../services/llm/utils/thinkingLevels';

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
 * Levels offered for a model: only those the provider/model treats
 * differently, so the dropdown never offers two choices that send the same
 * request. Every level when Nexus has no capability data for the model.
 */
export function getThinkingLevels(provider: string | undefined, model: string | undefined): ThinkingEffort[] {
  return getSupportedThinkingEfforts(provider, model);
}

/**
 * The dropdown value for a stored preference. With a provider/model, an effort
 * the model folds onto a neighbour shows as that neighbour (the level that is
 * really sent); the stored preference itself is left alone.
 */
export function thinkingToOption(
  thinking: ThinkingState | undefined,
  provider?: string,
  model?: string
): ThinkingOption {
  if (!thinking?.enabled) return 'off';
  if (provider === undefined && model === undefined) return thinking.effort;
  return normalizeThinkingEffortForModel(provider, model, thinking.effort);
}

export function optionToThinking(option: string, current: ThinkingState | undefined): ThinkingState {
  const effort = current?.effort ?? 'medium';
  if (option === 'off') return { enabled: false, effort };
  if ((THINKING_LEVELS as readonly string[]).includes(option)) {
    return { enabled: true, effort: option as ThinkingEffort };
  }
  return { enabled: current?.enabled ?? false, effort };
}
