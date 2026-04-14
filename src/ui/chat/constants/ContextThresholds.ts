export const CONTEXT_THRESHOLDS = {
  SAFE: 49,
  WARM: 74,
  HOT: 89,
  DANGER: 100,
};

export type ContextSeverity = 'safe' | 'warm' | 'hot' | 'danger';

export function percentageToState(percentage: number): ContextSeverity {
  if (percentage <= CONTEXT_THRESHOLDS.SAFE) return 'safe';
  if (percentage <= CONTEXT_THRESHOLDS.WARM) return 'warm';
  if (percentage <= CONTEXT_THRESHOLDS.HOT) return 'hot';
  return 'danger';
}
