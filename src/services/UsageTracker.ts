/**
 * Shared Usage Tracking Service
 * Handles cost tracking for LLM usage with provider-level breakdown
 */

export type UsageType = 'llm';

export interface ProviderUsage {
    [provider: string]: number; // Cost in USD
}

export interface UsageData {
    monthly: ProviderUsage;
    allTime: ProviderUsage;
    monthlyTotal: number;
    allTimeTotal: number;
    currentMonth: string;
    lastUpdated: string;
}

export interface BudgetStatus {
    monthlyBudget: number;
    currentSpending: number;
    percentageUsed: number;
    budgetExceeded: boolean;
    remainingBudget: number;
}

export interface UsageResponse {
    provider: string;
    cost: number;
    budgetStatus: BudgetStatus;
}

/**
 * Shared service for tracking usage costs by provider
 * Supports tracking for LLM usage
 */
export class UsageTracker {
    private readonly storageKeyPrefix: string;
    private readonly budgetKey: string;
    private readonly legacyStorageKeys: string[];
    private readonly legacyBudgetKeys: string[];
    
    constructor(
        private usageType: UsageType,
        private settings: any
    ) {
        this.storageKeyPrefix = `nexus-usage-${usageType}`;
        this.budgetKey = `nexus-budget-${usageType}`;
        this.legacyStorageKeys = [`claudesidian-usage-${usageType}`];
        this.legacyBudgetKeys = [`claudesidian-budget-${usageType}`];
    }

    /**
     * Track usage for a specific provider
     */
    async trackUsage(provider: string, cost: number): Promise<UsageResponse> {
        const usage = await this.loadUsageData();
        const currentMonth = this.getCurrentMonthKey();
        
        // Reset monthly stats if new month
        if (usage.currentMonth !== currentMonth) {
            usage.monthly = {};
            usage.monthlyTotal = 0;
            usage.currentMonth = currentMonth;
        }
        
        // Update monthly usage
        usage.monthly[provider] = (usage.monthly[provider] || 0) + cost;
        usage.monthlyTotal += cost;
        
        // Update all-time usage
        usage.allTime[provider] = (usage.allTime[provider] || 0) + cost;
        usage.allTimeTotal += cost;
        
        usage.lastUpdated = new Date().toISOString();
        
        await this.saveUsageData(usage);
        
        const budgetStatus = this.getBudgetStatus(usage.monthlyTotal);
        
        return {
            provider,
            cost,
            budgetStatus
        };
    }

    /**
     * Check if budget allows for a specific cost
     */
    async canAfford(cost: number): Promise<boolean> {
        const usage = await this.loadUsageData();
        const budget = this.getMonthlyBudget();
        
        if (budget <= 0) return true; // No budget set
        
        return (usage.monthlyTotal + cost) <= budget;
    }

    /**
     * Get current budget status
     */
    async getBudgetStatusAsync(): Promise<BudgetStatus> {
        const usage = await this.loadUsageData();
        return this.getBudgetStatus(usage.monthlyTotal);
    }

    /**
     * Get usage data for display
     */
    async getUsageData(): Promise<UsageData> {
        return await this.loadUsageData();
    }

    /**
     * Reset monthly usage
     */
    async resetMonthlyUsage(): Promise<void> {
        const usage = await this.loadUsageData();
        usage.monthly = {};
        usage.monthlyTotal = 0;
        usage.currentMonth = this.getCurrentMonthKey();
        usage.lastUpdated = new Date().toISOString();
        
        await this.saveUsageData(usage);
    }

    /**
     * Set monthly budget
     */
    setMonthlyBudget(budget: number): void {
        if (typeof localStorage === 'undefined') return;
        
        try {
            localStorage.setItem(this.budgetKey, budget.toString());
            this.cleanupLegacyKeys(this.legacyBudgetKeys);
        } catch (error) {
        }
    }

    /**
     * Get monthly budget
     */
    getMonthlyBudget(): number {
        if (typeof localStorage === 'undefined') return 0;
        
        try {
            const budget = this.getWithLegacyKeys(this.budgetKey, this.legacyBudgetKeys);
            return budget ? parseFloat(budget) : 0;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Load usage data from storage
     */
    private async loadUsageData(): Promise<UsageData> {
        const defaultData: UsageData = {
            monthly: {},
            allTime: {},
            monthlyTotal: 0,
            allTimeTotal: 0,
            currentMonth: this.getCurrentMonthKey(),
            lastUpdated: new Date().toISOString()
        };

        if (typeof localStorage === 'undefined') {
            return defaultData;
        }

        try {
            const stored = this.getWithLegacyKeys(this.storageKeyPrefix, this.legacyStorageKeys);
            if (!stored) return defaultData;

            const parsed = JSON.parse(stored) as UsageData;
            
            // Ensure all required fields exist
            return {
                monthly: parsed.monthly || {},
                allTime: parsed.allTime || {},
                monthlyTotal: parsed.monthlyTotal || 0,
                allTimeTotal: parsed.allTimeTotal || 0,
                currentMonth: parsed.currentMonth || this.getCurrentMonthKey(),
                lastUpdated: parsed.lastUpdated || new Date().toISOString()
            };
        } catch (error) {
            return defaultData;
        }
    }

    /**
     * Save usage data to storage
     */
    private async saveUsageData(data: UsageData): Promise<void> {
        if (typeof localStorage === 'undefined') return;

        try {
            localStorage.setItem(this.storageKeyPrefix, JSON.stringify(data));
            this.cleanupLegacyKeys(this.legacyStorageKeys);
        } catch (error) {
        }
    }

    private getWithLegacyKeys(primaryKey: string, legacyKeys: string[]): string | null {
        if (typeof localStorage === 'undefined') return null;

        const primaryValue = localStorage.getItem(primaryKey);
        if (primaryValue) {
            return primaryValue;
        }

        for (const key of legacyKeys) {
            const legacyValue = localStorage.getItem(key);
            if (legacyValue) {
                try {
                    localStorage.setItem(primaryKey, legacyValue);
                    this.cleanupLegacyKeys(legacyKeys);
                } catch (error) {
                }
                return legacyValue;
            }
        }

        return null;
    }

    private cleanupLegacyKeys(keys: string[]): void {
        if (typeof localStorage === 'undefined') return;

        for (const key of keys) {
            try {
                localStorage.removeItem(key);
            } catch {
                // Ignore cleanup errors
            }
        }
    }

    /**
     * Get budget status for current spending
     */
    private getBudgetStatus(currentSpending: number): BudgetStatus {
        const monthlyBudget = this.getMonthlyBudget();
        const percentageUsed = monthlyBudget > 0 ? (currentSpending / monthlyBudget) * 100 : 0;
        const budgetExceeded = monthlyBudget > 0 && currentSpending >= monthlyBudget;
        const remainingBudget = Math.max(0, monthlyBudget - currentSpending);

        return {
            monthlyBudget,
            currentSpending,
            percentageUsed: Math.round(percentageUsed * 100) / 100, // Round to 2 decimal places
            budgetExceeded,
            remainingBudget
        };
    }

    /**
     * Get current month key (YYYY-MM format)
     */
    private getCurrentMonthKey(): string {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
}
