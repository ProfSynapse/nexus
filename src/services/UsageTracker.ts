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
        private settings: Record<string, unknown>
    ) {
        this.storageKeyPrefix = `nexus-usage-${usageType}`;
        this.budgetKey = `nexus-budget-${usageType}`;
        this.legacyStorageKeys = [`claudesidian-usage-${usageType}`];
        this.legacyBudgetKeys = [`claudesidian-budget-${usageType}`];
    }

    private getLocalStorage(): Storage | null {
        return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
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
        const storage = this.getLocalStorage();
        if (!storage) return;
        
        try {
            storage.setItem(this.budgetKey, budget.toString());
            this.cleanupLegacyKeys(this.legacyBudgetKeys);
        } catch {
            return;
        }
    }

    /**
     * Get monthly budget
     */
    getMonthlyBudget(): number {
        const storage = this.getLocalStorage();
        if (!storage) return 0;
        
        try {
            const budget = this.getWithLegacyKeys(this.budgetKey, this.legacyBudgetKeys);
            return budget ? parseFloat(budget) : 0;
        } catch {
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

        const storage = this.getLocalStorage();
        if (!storage) {
            return defaultData;
        }

        try {
            const stored = this.getWithLegacyKeys(this.storageKeyPrefix, this.legacyStorageKeys);
            if (!stored) return defaultData;

            const parsed: unknown = JSON.parse(stored);
            if (!parsed || typeof parsed !== 'object') {
                return defaultData;
            }

            const usage = parsed as Partial<UsageData>;

            // Ensure all required fields exist
            return {
                monthly: usage.monthly || {},
                allTime: usage.allTime || {},
                monthlyTotal: usage.monthlyTotal || 0,
                allTimeTotal: usage.allTimeTotal || 0,
                currentMonth: usage.currentMonth || this.getCurrentMonthKey(),
                lastUpdated: usage.lastUpdated || new Date().toISOString()
            };
        } catch {
            return defaultData;
        }
    }

    /**
     * Save usage data to storage
     */
    private async saveUsageData(data: UsageData): Promise<void> {
        const storage = this.getLocalStorage();
        if (!storage) return;

        try {
            storage.setItem(this.storageKeyPrefix, JSON.stringify(data));
            this.cleanupLegacyKeys(this.legacyStorageKeys);
        } catch {
            return;
        }
    }

    private getWithLegacyKeys(primaryKey: string, legacyKeys: string[]): string | null {
        const storage = this.getLocalStorage();
        if (!storage) return null;

        const primaryValue = storage.getItem(primaryKey);
        if (primaryValue) {
            return primaryValue;
        }

        for (const key of legacyKeys) {
            const legacyValue = storage.getItem(key);
            if (legacyValue) {
                try {
                    storage.setItem(primaryKey, legacyValue);
                    this.cleanupLegacyKeys(legacyKeys);
                } catch {
                    return legacyValue;
                }
                return legacyValue;
            }
        }

        return null;
    }

    private cleanupLegacyKeys(keys: string[]): void {
        const storage = this.getLocalStorage();
        if (!storage) return;

        for (const key of keys) {
            try {
                storage.removeItem(key);
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
