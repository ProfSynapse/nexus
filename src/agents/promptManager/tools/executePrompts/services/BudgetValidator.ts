import { UsageTracker, type BudgetStatus } from '../../../../../services/UsageTracker';

/**
 * Service responsible for validating budget constraints before prompt execution
 * Follows SRP by focusing only on budget-related validation
 */
export class BudgetValidator {
  constructor(private usageTracker?: UsageTracker) {}

  /**
   * Check if the monthly budget has been exceeded
   * @throws Error if budget is exceeded
   */
  validateBudget(): void {
    if (!this.usageTracker) {
      return; // No budget tracking configured
    }

    const budgetStatus = this.usageTracker.getBudgetStatusAsync();
    if (budgetStatus.budgetExceeded) {
      throw new Error(
        `Monthly LLM budget of $${budgetStatus.monthlyBudget.toFixed(2)} has been exceeded. ` +
        `Current spending: $${budgetStatus.currentSpending.toFixed(2)}. ` +
        `Please reset or increase your budget in settings.`
      );
    }
  }

  /**
   * Track usage after successful execution
   * @param provider LLM provider used
   * @param cost Total cost of the execution
   */
  trackUsage(provider: string, cost: number): void {
    if (!this.usageTracker) {
      return; // No usage tracking configured
    }

    try {
      this.usageTracker.trackUsage(provider.toLowerCase(), cost);
    } catch (error) {
      console.error('Failed to track LLM usage:', error);
      // Don't fail the request if usage tracking fails
    }
  }

  /**
   * Get current budget status for reporting
   */
  getBudgetStatus(): BudgetStatus | null {
    if (!this.usageTracker) {
      return null;
    }

    return this.usageTracker.getBudgetStatusAsync();
  }
}