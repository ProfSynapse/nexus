/**
 * DependencyValidator - Handles service dependency validation
 * Follows Single Responsibility Principle by focusing only on dependency validation
 */

import { LLMProviderManager } from '../../../../../services/llm/providers/ProviderManager';
import { CustomPromptStorageService } from '../../../services/CustomPromptStorageService';
import { AgentManager } from '../../../../../services/AgentManager';
import { UsageTracker } from '../../../../../services/UsageTracker';

export interface DependencyValidationResult {
    isValid: boolean;
    error?: string;
    warnings?: string[];
}

export interface ServiceDependencies {
    providerManager: LLMProviderManager | null;
    promptStorage: CustomPromptStorageService | null;
    agentManager: AgentManager | null;
    usageTracker: UsageTracker | null;
}

/**
 * Service responsible for validating service dependencies
 * Follows SRP by focusing only on dependency validation operations
 */
export class DependencyValidator {
    constructor(private dependencies: ServiceDependencies) {}

    /**
     * Wait for a specific dependency to be initialized
     * @param dependencyName Name of the dependency to wait for
     * @param timeoutMs Maximum time to wait in milliseconds
     * @private
     */
    private async waitForDependency(dependencyName: keyof ServiceDependencies, timeoutMs: number): Promise<void> {
        const startTime = Date.now();
        const checkInterval = 100; // Check every 100ms
        
        while (Date.now() - startTime < timeoutMs) {
            if (this.dependencies[dependencyName]) {
                return;
            }
            
            // Wait for the next check
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
    }

    /**
     * Validate all required dependencies
     */
    async validateDependencies(): Promise<DependencyValidationResult> {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Try to wait for critical dependencies if they're not available
        if (!this.dependencies.providerManager) {
            await this.waitForDependency('providerManager', 3000);
        }

        if (!this.dependencies.promptStorage) {
            await this.waitForDependency('promptStorage', 3000);
        }

        // Validate critical dependencies
        if (!this.dependencies.providerManager) {
            errors.push('LLM Provider Manager not initialized. Please ensure you have configured at least one LLM provider with valid API keys.');
        }

        if (!this.dependencies.promptStorage) {
            errors.push('Prompt storage service not initialized');
        }

        // Validate optional dependencies
        if (!this.dependencies.agentManager) {
            warnings.push('Agent manager not available - actions will not be supported');
        }

        if (!this.dependencies.usageTracker) {
            warnings.push('Usage tracker not available - budget tracking disabled');
        }

        return {
            isValid: errors.length === 0,
            error: errors.length > 0 ? errors.join(', ') : undefined,
            warnings
        };
    }

    /**
     * Validate specific service availability
     */
    validateService(serviceName: keyof ServiceDependencies): DependencyValidationResult {
        const service = this.dependencies[serviceName];
        
        if (!service) {
            return {
                isValid: false,
                error: `${serviceName} not available`
            };
        }

        return {
            isValid: true
        };
    }

    /**
     * Validate custom prompt agent availability
     * Supports both agent name and agent ID for lookup
     */
    async validateCustomPromptAgent(agentIdentifier: string): Promise<DependencyValidationResult> {
        if (!this.dependencies.promptStorage) {
            return {
                isValid: false,
                error: 'Custom agent specified but prompt storage not available'
            };
        }

        try {
            // Use unified lookup that tries ID first, then name
            const customPrompt = await this.dependencies.promptStorage.getPromptByNameOrId(agentIdentifier);

            if (!customPrompt) {
                return {
                    isValid: false,
                    error: `Custom prompt agent '${agentIdentifier}' not found (searched by both name and ID)`
                };
            }

            if (!customPrompt.isEnabled) {
                return {
                    isValid: false,
                    error: `Custom prompt agent '${agentIdentifier}' is disabled`
                };
            }

            return {
                isValid: true
            };
        } catch (error) {
            return {
                isValid: false,
                error: `Failed to validate custom prompt agent: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Get service availability status
     */
    getServiceStatus(): {
        providerManager: boolean;
        promptStorage: boolean;
        agentManager: boolean;
        usageTracker: boolean;
    } {
        return {
            providerManager: !!this.dependencies.providerManager,
            promptStorage: !!this.dependencies.promptStorage,
            agentManager: !!this.dependencies.agentManager,
            usageTracker: !!this.dependencies.usageTracker
        };
    }

    /**
     * Get dependency statistics
     */
    getDependencyStatistics(): {
        totalServices: number;
        availableServices: number;
        criticalServices: number;
        availableCriticalServices: number;
        optionalServices: number;
        availableOptionalServices: number;
    } {
        const status = this.getServiceStatus();
        const criticalServices = ['providerManager', 'promptStorage'];
        const optionalServices = ['agentManager', 'usageTracker'];

        const availableServices = Object.values(status).filter(Boolean).length;
        const availableCriticalServices = criticalServices.filter(service => 
            status[service as keyof typeof status]
        ).length;
        const availableOptionalServices = optionalServices.filter(service =>
            status[service as keyof typeof status]
        ).length;

        return {
            totalServices: 4,
            availableServices,
            criticalServices: criticalServices.length,
            availableCriticalServices,
            optionalServices: optionalServices.length,
            availableOptionalServices
        };
    }

    /**
     * Update dependencies
     */
    updateDependencies(newDependencies: Partial<ServiceDependencies>): void {
        Object.assign(this.dependencies, newDependencies);
    }

    /**
     * Get current dependencies
     */
    getDependencies(): ServiceDependencies {
        return { ...this.dependencies };
    }

    /**
     * Get dependency descriptions
     */
    getDependencyDescriptions(): Record<keyof ServiceDependencies, string> {
        return {
            providerManager: 'LLM Provider Manager for executing prompts',
            promptStorage: 'Custom Prompt Storage Service for agent management',
            agentManager: 'Agent Manager for executing content actions',
            usageTracker: 'Usage Tracker for budget and cost tracking'
        };
    }

    /**
     * Get missing dependencies
     */
    getMissingDependencies(): string[] {
        const status = this.getServiceStatus();
        return Object.entries(status)
            .filter(([_, available]) => !available)
            .map(([serviceName]) => serviceName);
    }

    /**
     * Check if actions are supported
     */
    areActionsSupported(): boolean {
        return !!this.dependencies.agentManager;
    }

    /**
     * Check if budget tracking is supported
     */
    isBudgetTrackingSupported(): boolean {
        return !!this.dependencies.usageTracker;
    }

    /**
     * Check if custom prompts are supported
     */
    areCustomPromptsSupported(): boolean {
        return !!this.dependencies.promptStorage;
    }
}