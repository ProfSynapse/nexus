/**
 * PromptExecutor - Handles LLM prompt execution
 * Follows Single Responsibility Principle by focusing only on prompt execution
 */

import { LLMProviderManager } from '../../../../../services/llm/providers/ProviderManager';
import { CustomPromptStorageService } from '../../../services/CustomPromptStorageService';
import { ExecutePromptParams } from '../ExecutePrompt';

export interface PromptExecutionResult {
    success: boolean;
    response?: string;
    model?: string;
    provider?: string;
    agentUsed: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    cost?: {
        inputCost: number;
        outputCost: number;
        totalCost: number;
        currency: string;
    };
    filesIncluded?: string[];
    webSearchResults?: any[];
    error?: string;
}

/**
 * Service responsible for executing LLM prompts
 * Follows SRP by focusing only on prompt execution operations
 */
export class PromptExecutor {
    constructor(
        private providerManager: LLMProviderManager,
        private promptStorage: CustomPromptStorageService
    ) {}

    /**
     * Execute prompt with optional custom agent
     */
    async executePrompt(params: ExecutePromptParams): Promise<PromptExecutionResult> {
        try {
            // Get custom prompt/agent if specified
            const customPrompt = await this.getCustomPrompt(params.agent);
            const agentUsed = customPrompt?.name || 'default';

            // Execute the LLM prompt
            const llmService = this.providerManager.getLLMService();
            const result = await llmService.executePrompt({
                systemPrompt: customPrompt?.prompt || '', // Use custom prompt if available, otherwise empty
                userPrompt: params.prompt,
                filepaths: params.filepaths,
                provider: params.provider,
                model: params.model,
                temperature: params.temperature,
                maxTokens: params.maxTokens,
                webSearch: params.webSearch
            });

            if (!result.success) {
                return {
                    success: false,
                    agentUsed,
                    error: result.error || 'LLM execution failed'
                };
            }

            return {
                success: true,
                response: result.response || '',
                model: result.model || 'unknown',
                provider: result.provider || 'unknown',
                agentUsed,
                usage: result.usage,
                cost: result.cost,
                filesIncluded: result.filesIncluded,
                webSearchResults: result.webSearchResults
            };
        } catch (error) {
            return {
                success: false,
                agentUsed: 'default',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * Get custom prompt by name or ID (unified lookup)
     * Supports both agent name and agent ID for flexibility
     */
    private async getCustomPrompt(agentIdentifier?: string): Promise<any> {
        if (!agentIdentifier) {
            return null;
        }

        try {
            // Use unified lookup that tries ID first, then name
            const customPrompt = await this.promptStorage.getPromptByNameOrId(agentIdentifier);
            return customPrompt && customPrompt.isEnabled ? customPrompt : null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Validate prompt parameters
     */
    validatePromptParameters(params: ExecutePromptParams): {
        isValid: boolean;
        errors: string[];
        warnings: string[];
    } {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Validate required parameters
        if (!params.prompt || typeof params.prompt !== 'string' || params.prompt.trim() === '') {
            errors.push('Prompt is required and must be a non-empty string');
        }

        // Validate optional parameters
        if (params.filepaths && !Array.isArray(params.filepaths)) {
            errors.push('Filepaths must be an array');
        }

        if (params.filepaths && params.filepaths.some(path => typeof path !== 'string')) {
            errors.push('All filepaths must be strings');
        }

        if (params.provider && typeof params.provider !== 'string') {
            errors.push('Provider must be a string');
        }

        if (params.model && typeof params.model !== 'string') {
            errors.push('Model must be a string');
        }

        if (params.temperature !== undefined) {
            if (typeof params.temperature !== 'number' || params.temperature < 0 || params.temperature > 1) {
                errors.push('Temperature must be a number between 0 and 1');
            }
        }

        if (params.maxTokens !== undefined) {
            if (typeof params.maxTokens !== 'number' || params.maxTokens < 1) {
                errors.push('MaxTokens must be a positive number');
            }
        }

        // Warnings
        if (params.agent && typeof params.agent !== 'string') {
            warnings.push('Agent name should be a string');
        }

        if (params.filepaths && params.filepaths.length === 0) {
            warnings.push('Empty filepaths array provided');
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        };
    }

    /**
     * Get execution statistics
     */
    getExecutionStatistics(): {
        hasProviderManager: boolean;
        hasPromptStorage: boolean;
        canExecutePrompts: boolean;
        supportsCustomPrompts: boolean;
    } {
        return {
            hasProviderManager: !!this.providerManager,
            hasPromptStorage: !!this.promptStorage,
            canExecutePrompts: !!(this.providerManager && this.providerManager.getLLMService()),
            supportsCustomPrompts: !!this.promptStorage
        };
    }

    /**
     * Get available models for validation
     */
    getAvailableModels(): string[] {
        if (!this.providerManager) {
            return [];
        }

        try {
            const llmService = this.providerManager.getLLMService();
            const models = llmService.getAvailableModels?.();
            if (Array.isArray(models)) {
                return models;
            }
            return [];
        } catch (error) {
            return [];
        }
    }

    /**
     * Get available providers for validation
     */
    getAvailableProviders(): string[] {
        if (!this.providerManager) {
            return [];
        }

        try {
            const llmService = this.providerManager.getLLMService();
            const providers = llmService.getAvailableProviders?.();
            if (Array.isArray(providers)) {
                return providers;
            }
            return [];
        } catch (error) {
            return [];
        }
    }

    /**
     * Test prompt execution capability
     */
    async testExecutionCapability(): Promise<{
        canExecute: boolean;
        error?: string;
    }> {
        try {
            if (!this.providerManager) {
                return {
                    canExecute: false,
                    error: 'Provider manager not available'
                };
            }

            const llmService = this.providerManager.getLLMService();
            if (!llmService) {
                return {
                    canExecute: false,
                    error: 'LLM service not available'
                };
            }

            // Test with a simple prompt
            const testResult = await llmService.executePrompt({
                systemPrompt: '',
                userPrompt: 'Hello',
                filepaths: [],
                provider: undefined,
                model: undefined,
                temperature: 0.1,
                maxTokens: 10
            });

            return {
                canExecute: true
            };
        } catch (error) {
            return {
                canExecute: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * Get prompt execution context
     */
    getExecutionContext(params: ExecutePromptParams): {
        hasCustomAgent: boolean;
        hasFilepaths: boolean;
        hasCustomProvider: boolean;
        hasCustomModel: boolean;
        hasTemperature: boolean;
        hasMaxTokens: boolean;
    } {
        return {
            hasCustomAgent: !!params.agent,
            hasFilepaths: !!(params.filepaths && params.filepaths.length > 0),
            hasCustomProvider: !!params.provider,
            hasCustomModel: !!params.model,
            hasTemperature: params.temperature !== undefined,
            hasMaxTokens: params.maxTokens !== undefined
        };
    }
}