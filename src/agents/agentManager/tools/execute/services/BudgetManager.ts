/**
 * BudgetManager - Handles budget validation and usage tracking
 * Follows Single Responsibility Principle by focusing only on budget operations
 */

import { UsageTracker, BudgetStatus } from '../../../../../services/UsageTracker';

export interface BudgetValidationResult {
    isValid: boolean;
    budgetStatus?: BudgetStatus;
    error?: string;
}

export interface UsageTrackingResult {
    success: boolean;
    budgetStatus?: BudgetStatus;
    error?: string;
}

/**
 * Service responsible for budget validation and usage tracking
 * Follows SRP by focusing only on budget management operations
 */
export class BudgetManager {
    constructor(private usageTracker: UsageTracker | null) {}

    /**
     * Validate budget before LLM execution
     */
    async validateBudget(): Promise<BudgetValidationResult> {
        if (!this.usageTracker) {
            return {
                isValid: true // No budget tracking available, allow execution
            };
        }

        try {
            const budgetStatus = await this.usageTracker.getBudgetStatusAsync();
            
            if (budgetStatus.budgetExceeded) {
                return {
                    isValid: false,
                    budgetStatus,
                    error: `Monthly LLM budget of $${budgetStatus.monthlyBudget.toFixed(2)} has been exceeded. Current spending: $${budgetStatus.currentSpending.toFixed(2)}. Please reset or increase your budget in settings.`
                };
            }

            return {
                isValid: true,
                budgetStatus
            };
        } catch (error) {
            console.error('BudgetManager: Failed to validate budget:', error);
            return {
                isValid: true, // Allow execution if budget check fails
                error: error instanceof Error ? error.message : 'Unknown budget validation error'
            };
        }
    }

    /**
     * Track usage after LLM execution
     */
    async trackUsage(provider: string, cost: number): Promise<UsageTrackingResult> {
        if (!this.usageTracker) {
            return {
                success: true // No usage tracking available
            };
        }

        if (!provider || typeof cost !== 'number' || cost <= 0) {
            return {
                success: false,
                error: 'Invalid provider or cost for usage tracking'
            };
        }

        try {
            const usageResponse = await this.usageTracker.trackUsage(
                provider.toLowerCase(),
                cost
            );

            return {
                success: true,
                budgetStatus: usageResponse.budgetStatus
            };
        } catch (error) {
            console.error('BudgetManager: Failed to track usage:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown usage tracking error'
            };
        }
    }

    /**
     * Get current budget status
     */
    async getCurrentBudgetStatus(): Promise<BudgetStatus | null> {
        if (!this.usageTracker) {
            return null;
        }

        try {
            return await this.usageTracker.getBudgetStatusAsync();
        } catch (error) {
            console.error('BudgetManager: Failed to get budget status:', error);
            return null;
        }
    }

    /**
     * Check if budget tracking is available
     */
    isBudgetTrackingAvailable(): boolean {
        return !!this.usageTracker;
    }

    /**
     * Get budget tracking capability
     */
    getBudgetTrackingCapability(): {
        hasBudgetTracking: boolean;
        canValidateBudget: boolean;
        canTrackUsage: boolean;
    } {
        const hasTracker = !!this.usageTracker;
        
        return {
            hasBudgetTracking: hasTracker,
            canValidateBudget: hasTracker && typeof this.usageTracker!.getBudgetStatusAsync === 'function',
            canTrackUsage: hasTracker && typeof this.usageTracker!.trackUsage === 'function'
        };
    }

    /**
     * Get budget summary
     */
    async getBudgetSummary(): Promise<{
        hasBudgetTracking: boolean;
        budgetStatus?: BudgetStatus;
        budgetUtilization?: number;
        remainingBudget?: number;
        error?: string;
    }> {
        if (!this.usageTracker) {
            return {
                hasBudgetTracking: false
            };
        }

        try {
            const budgetStatus = await this.usageTracker.getBudgetStatusAsync();
            const budgetUtilization = budgetStatus.monthlyBudget > 0 
                ? (budgetStatus.currentSpending / budgetStatus.monthlyBudget) * 100
                : 0;
            const remainingBudget = Math.max(0, budgetStatus.monthlyBudget - budgetStatus.currentSpending);

            return {
                hasBudgetTracking: true,
                budgetStatus,
                budgetUtilization,
                remainingBudget
            };
        } catch (error) {
            return {
                hasBudgetTracking: true,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * Validate cost parameter
     */
    validateCost(cost: any): {
        isValid: boolean;
        error?: string;
    } {
        if (cost === undefined || cost === null) {
            return {
                isValid: false,
                error: 'Cost is required for budget tracking'
            };
        }

        if (typeof cost !== 'number') {
            return {
                isValid: false,
                error: 'Cost must be a number'
            };
        }

        if (cost < 0) {
            return {
                isValid: false,
                error: 'Cost cannot be negative'
            };
        }

        if (!isFinite(cost)) {
            return {
                isValid: false,
                error: 'Cost must be a finite number'
            };
        }

        return {
            isValid: true
        };
    }

    /**
     * Validate provider parameter
     */
    validateProvider(provider: any): {
        isValid: boolean;
        error?: string;
    } {
        if (!provider) {
            return {
                isValid: false,
                error: 'Provider is required for budget tracking'
            };
        }

        if (typeof provider !== 'string') {
            return {
                isValid: false,
                error: 'Provider must be a string'
            };
        }

        if (provider.trim() === '') {
            return {
                isValid: false,
                error: 'Provider cannot be empty'
            };
        }

        return {
            isValid: true
        };
    }

    /**
     * Update usage tracker
     */
    updateUsageTracker(usageTracker: UsageTracker | null): void {
        this.usageTracker = usageTracker;
    }

    /**
     * Test budget tracking capability
     */
    async testBudgetTracking(): Promise<{
        canTrack: boolean;
        error?: string;
    }> {
        if (!this.usageTracker) {
            return {
                canTrack: false,
                error: 'Usage tracker not available'
            };
        }

        try {
            // Test getting budget status
            const budgetStatus = await this.usageTracker.getBudgetStatusAsync();
            
            if (!budgetStatus) {
                return {
                    canTrack: false,
                    error: 'Budget status not available'
                };
            }

            return {
                canTrack: true
            };
        } catch (error) {
            return {
                canTrack: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * Get usage statistics
     */
    async getUsageStatistics(): Promise<{
        hasUsageTracker: boolean;
        totalSpending?: number;
        monthlyBudget?: number;
        budgetExceeded?: boolean;
        daysInMonth?: number;
        error?: string;
    }> {
        if (!this.usageTracker) {
            return {
                hasUsageTracker: false
            };
        }

        try {
            const budgetStatus = await this.usageTracker.getBudgetStatusAsync();
            
            return {
                hasUsageTracker: true,
                totalSpending: budgetStatus.currentSpending,
                monthlyBudget: budgetStatus.monthlyBudget,
                budgetExceeded: budgetStatus.budgetExceeded,
                daysInMonth: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()
            };
        } catch (error) {
            return {
                hasUsageTracker: true,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
}