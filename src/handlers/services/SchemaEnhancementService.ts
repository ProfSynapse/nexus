/**
 * Location: src/handlers/services/SchemaEnhancementService.ts
 *
 * Central service for enhancing tool schemas with additional properties,
 * validation rules, and improvements through registered schema providers.
 * Used by ToolListService to enhance schemas before returning to clients.
 */

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ISchemaEnhancementService } from '../interfaces/IRequestHandlerServices';
import { ISchemaProvider, EnhancedJSONSchema } from '../interfaces/ISchemaProvider';
import { logger } from '../../utils/logger';
import { getErrorMessage } from '../../utils/errorUtils';

export class SchemaEnhancementService implements ISchemaEnhancementService {
    private providers: ISchemaProvider[] = [];

    /**
     * Register a schema enhancement provider
     */
    registerProvider(provider: ISchemaProvider): void {
        try {
            // Check if provider is already registered
            if (this.providers.some(p => p.name === provider.name)) {
                logger.systemLog(`Schema provider ${provider.name} already registered, skipping`);
                return;
            }

            this.providers.push(provider);
            
            // Sort providers by priority (highest first)
            this.providers.sort((a, b) => b.getPriority() - a.getPriority());
            
            logger.systemLog(`Registered schema provider: ${provider.name} (priority: ${provider.getPriority()})`);
        } catch (error) {
            logger.systemError(error as Error, `Error registering schema provider: ${provider.name}`);
        }
    }

    /**
     * Unregister a schema enhancement provider
     */
    unregisterProvider(providerName: string): boolean {
        try {
            const initialLength = this.providers.length;
            this.providers = this.providers.filter(p => p.name !== providerName);
            
            const wasRemoved = this.providers.length < initialLength;
            if (wasRemoved) {
                logger.systemLog(`Unregistered schema provider: ${providerName}`);
            }
            
            return wasRemoved;
        } catch (error) {
            logger.systemError(error as Error, `Error unregistering schema provider: ${providerName}`);
            return false;
        }
    }

    /**
     * Enhance a tool schema using all applicable registered providers
     */
    async enhanceToolSchema(toolName: string, baseSchema: EnhancedJSONSchema): Promise<EnhancedJSONSchema> {
        try {
            // Validate input
            if (!toolName || typeof toolName !== 'string') {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    'Tool name must be a non-empty string'
                );
            }

            if (!baseSchema || typeof baseSchema !== 'object') {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    'Base schema must be a valid object'
                );
            }

            // Start with a deep clone of the base schema to avoid mutations
            let enhancedSchema = JSON.parse(JSON.stringify(baseSchema));

            // Track which providers were applied for debugging
            const appliedProviders: string[] = [];

            // Apply each provider that can enhance this tool
            for (const provider of this.providers) {
                try {
                    const canEnhance = await provider.canEnhance(toolName, enhancedSchema);
                    if (canEnhance) {
                        const providerResult = await provider.enhanceSchema(toolName, enhancedSchema);
                        
                        // Validate the provider returned a valid schema
                        if (providerResult && typeof providerResult === 'object') {
                            enhancedSchema = providerResult;
                            appliedProviders.push(provider.name);
                            logger.systemLog(`Applied schema enhancement: ${provider.name} to ${toolName}`);
                        } else {
                            logger.systemError(
                                new Error(`Invalid schema returned from provider: ${provider.name}`),
                                'Schema Enhancement'
                            );
                        }
                    }
                } catch (error) {
                    logger.systemError(
                        error as Error,
                        `Error applying schema provider ${provider.name} to tool ${toolName}: ${getErrorMessage(error)}`
                    );
                    // Continue with other providers instead of failing completely
                }
            }

            // Log enhancement summary
            if (appliedProviders.length > 0) {
                logger.systemLog(`Enhanced schema for ${toolName} with providers: ${appliedProviders.join(', ')}`);
            }

            return enhancedSchema;

        } catch (error) {
            logger.systemError(error as Error, `Error enhancing schema for tool ${toolName}`);
            
            // Return original schema on error to avoid breaking tool functionality
            if (error instanceof McpError) {
                throw error;
            } else {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to enhance schema for tool ${toolName}`,
                    error
                );
            }
        }
    }

    /**
     * Get list of available enhancement provider names
     */
    async getAvailableEnhancements(): Promise<string[]> {
        try {
            return this.providers.map(provider => provider.name);
        } catch (error) {
            logger.systemError(error as Error, 'Error getting available enhancements');
            return [];
        }
    }

    /**
     * Get detailed information about registered providers
     */
    getProviderInfo(): Array<{ name: string; description: string; priority: number }> {
        try {
            return this.providers.map(provider => ({
                name: provider.name,
                description: provider.description,
                priority: provider.getPriority()
            }));
        } catch (error) {
            logger.systemError(error as Error, 'Error getting provider info');
            return [];
        }
    }

    /**
     * Check if a specific provider is registered
     */
    hasProvider(providerName: string): boolean {
        return this.providers.some(p => p.name === providerName);
    }

    /**
     * Clear all registered providers (mainly for testing)
     */
    clearProviders(): void {
        const count = this.providers.length;
        this.providers = [];
        logger.systemLog(`Cleared ${count} schema enhancement providers`);
    }
}