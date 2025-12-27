import { UsageTracker } from '../../../../../services/UsageTracker';

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
  async validateBudget(): Promise<void> {
    if (!this.usageTracker) {
      return; // No budget tracking configured
    }

    const budgetStatus = await this.usageTracker.getBudgetStatusAsync();
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
  async trackUsage(provider: string, cost: number): Promise<void> {
    if (!this.usageTracker) {
      return; // No usage tracking configured
    }

    try {
      await this.usageTracker.trackUsage(provider.toLowerCase(), cost);
    } catch (error) {
      console.error('Failed to track LLM usage:', error);
      // Don't fail the request if usage tracking fails
    }
  }

  /**
   * Get current budget status for reporting
   */
  async getBudgetStatus() {
    if (!this.usageTracker) {
      return null;
    }

    return await this.usageTracker.getBudgetStatusAsync();
  }
}