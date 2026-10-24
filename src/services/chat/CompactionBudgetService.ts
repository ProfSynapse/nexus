export interface CompactionBudgetInput {
  contextWindow: number;
  maxOutputTokens?: number;
  fixedPromptTokens?: number;
  retainedTokens?: number;
}

/** Budgets use the selected/allocated window, including local runtime limits. */
export class CompactionBudgetService {
  static getStateBudget(input: CompactionBudgetInput): number {
    const window = Math.floor(input.contextWindow);
    if (!Number.isFinite(window) || window <= 0) throw new Error('The selected context window is unknown');
    const outputLimit = typeof input.maxOutputTokens === 'number' && Number.isFinite(input.maxOutputTokens)
      && input.maxOutputTokens > 0 ? Math.floor(input.maxOutputTokens) : window;
    const target = Math.floor(window * 0.1);
    const responseReserve = Math.min(outputLimit, target);
    const available = Math.floor(window * 0.9) - (input.fixedPromptTokens ?? 0)
      - (input.retainedTokens ?? 0) - responseReserve - Math.max(32, Math.ceil(window * 0.02));
    const budget = Math.floor(Math.min(target, outputLimit, available));
    if (budget < 64) throw new Error('Instructions, tool schemas and recent turns leave no room for a saved state. Increase the context window or load fewer instructions.');
    return budget;
  }
}
