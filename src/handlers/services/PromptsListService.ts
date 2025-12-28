import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IPromptsListService } from '../interfaces/IRequestHandlerServices';
import { logger } from '../../utils/logger';
import { CustomPromptStorageService } from "../../agents/promptManager/services/CustomPromptStorageService";

/**
 * Prompt interface for MCP prompt listing
 */
interface Prompt {
    name: string;
    description?: string;
    arguments?: Array<{
        name: string;
        description?: string;
        required?: boolean;
    }>;
}

/**
 * Service for listing available prompts
 * Applies Single Responsibility Principle by focusing solely on prompt enumeration
 * 
 * Includes both system prompts and user-defined custom prompts
 */
export class PromptsListService implements IPromptsListService {
    private customPromptStorage?: CustomPromptStorageService;

    constructor(customPromptStorage?: CustomPromptStorageService) {
        this.customPromptStorage = customPromptStorage;
    }

    /**
     * Get all available prompts
     * @returns Promise resolving to array of prompts
     */
    async listPrompts(): Promise<{ prompts: Prompt[] }> {
        try {
            
            const prompts: Prompt[] = [];
            
            // Add system prompts (currently none)
            // Future enhancement: Could add predefined system prompt templates
            
            // Add custom prompts if storage service is available
            if (this.customPromptStorage && this.customPromptStorage.isEnabled()) {
                const customPrompts = this.customPromptStorage.getEnabledPrompts();
                
                // Convert custom prompts to MCP Prompt format
                const mcpPrompts = customPrompts.map(customPrompt => ({
                    name: customPrompt.name,
                    description: customPrompt.description,
                    // Custom prompts don't have arguments for now
                    arguments: []
                }));
                
                prompts.push(...mcpPrompts);
            }
            
            return { prompts };
        } catch (error) {
            logger.systemError(error as Error, 'PromptsListService');
            throw new McpError(ErrorCode.InternalError, 'Failed to list prompts', error);
        }
    }

    /**
     * Get prompts by category (future enhancement)
     * @param category Optional category to filter prompts
     * @returns Promise resolving to filtered prompts
     */
    async listPromptsByCategory(category?: string): Promise<{ prompts: Prompt[] }> {
        try {
            const allPrompts = await this.listPrompts();
            
            if (!category) {
                return allPrompts;
            }
            
            // Future: Filter prompts by category when implemented
            return { prompts: [] };
        } catch (error) {
            logger.systemError(error as Error, 'PromptsListService');
            throw new McpError(ErrorCode.InternalError, 'Failed to list prompts by category', error);
        }
    }

    /**
     * Check if prompt exists by name
     * @param name Prompt name
     * @returns Promise resolving to boolean
     */
    async promptExists(name: string): Promise<boolean> {
        try {
            // Check custom prompts first if available
            if (this.customPromptStorage && this.customPromptStorage.isEnabled()) {
                const customPrompt = this.customPromptStorage.getPromptByNameOrId(name);
                if (customPrompt && customPrompt.isEnabled) {
                    return true;
                }
            }
            
            // Check system prompts (currently none)
            // Future: Add system prompt checking here
            
            return false;
        } catch (error) {
            logger.systemWarn(`PromptsListService: Prompt existence check failed for ${name}`);
            return false;
        }
    }

    /**
     * Get a specific prompt by name (for MCP prompts/get endpoint)
     * @param name Prompt name
     * @returns Promise resolving to prompt content or null
     */
    async getPrompt(name: string): Promise<string | null> {
        try {
            if (this.customPromptStorage && this.customPromptStorage.isEnabled()) {
                const customPrompt = this.customPromptStorage.getPromptByNameOrId(name);
                if (customPrompt && customPrompt.isEnabled) {
                    return customPrompt.prompt;
                }
            }
            
            // Check system prompts (currently none)
            // Future: Add system prompt retrieval here
            
            return null;
        } catch (error) {
            logger.systemError(error as Error, 'PromptsListService');
            return null;
        }
    }
}