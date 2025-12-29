/**
 * Location: src/handlers/services/providers/AgentSchemaProvider.ts
 *
 * Schema provider for dynamic domain agent and prompt ID injection into PromptManager tool schemas.
 * Extends BaseSchemaProvider to enhance PromptManager tool schemas with available domain agent names,
 * custom prompt IDs, and contextual descriptions. Used by SchemaEnhancementService to
 * provide dynamic agent and prompt context for better AI assistant understanding.
 */

import { BaseSchemaProvider } from '../BaseSchemaProvider';
import { EnhancedJSONSchema } from '../../interfaces/ISchemaProvider';
import { IAgent } from '../../../agents/interfaces/IAgent';
import { CustomPromptStorageService } from '../../../agents/promptManager/services/CustomPromptStorageService';
import { CustomPrompt } from '../../../types';
import { logger } from '../../../utils/logger';

interface AgentInfo {
    name: string;
    description: string;
    enabled: boolean;
}

interface PromptInfo {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
}

interface CachedData {
    agents: AgentInfo[];
    prompts: PromptInfo[];
    timestamp: number;
}

/**
 * Schema provider that injects available domain agent names and custom prompt IDs
 * into PromptManager tool schemas for dynamic context enhancement
 */
export class AgentSchemaProvider extends BaseSchemaProvider {
    readonly name = 'AgentSchemaProvider';
    readonly description = 'Injects available domain agent names and custom prompt IDs into PromptManager tool schemas';
    
    private cache: CachedData | null = null;
    private readonly CACHE_DURATION_MS = 30000; // 30 seconds
    private readonly MAX_AGENTS_TO_SHOW = 15;
    private readonly MAX_PROMPTS_TO_SHOW = 10;

    private agentsMap: Map<string, IAgent> | null = null;
    private customPromptStorage: CustomPromptStorageService | null = null;

    /**
     * Set the agents map for querying available agents
     */
    setAgentsMap(agentsMap: Map<string, IAgent>): void {
        this.agentsMap = agentsMap;
        this.clearCache(); // Clear cache when agents change
    }

    /**
     * Set the custom prompt storage service for querying custom prompts
     */
    setCustomPromptStorage(customPromptStorage: CustomPromptStorageService): void {
        this.customPromptStorage = customPromptStorage;
        this.clearCache(); // Clear cache when storage changes
    }

    /**
     * Get priority for this provider (higher than base providers)
     */
    getPriority(): number {
        return 200; // High priority for agent-specific enhancements
    }

    /**
     * Check if this provider should enhance the given tool schema
     * Only enhances PromptManager tool schemas
     */
    protected shouldEnhanceToolName(toolName: string): boolean {
        return toolName.startsWith('promptManager-');
    }

    /**
     * Enhance PromptManager tool schemas with domain agent names and prompt IDs
     */
    async enhanceSchema(toolName: string, baseSchema: EnhancedJSONSchema): Promise<EnhancedJSONSchema> {
        return await this.safeEnhance(
            async () => this.performEnhancement(toolName, baseSchema),
            baseSchema,
            'enhanceSchema'
        );
    }

    /**
     * Perform the actual schema enhancement
     */
    private async performEnhancement(toolName: string, baseSchema: EnhancedJSONSchema): Promise<EnhancedJSONSchema> {
        // Get cached or fresh data
        const data = await this.getCachedData();

        // Clone the base schema
        const enhanced = this.cloneSchema(baseSchema);

        // Extract the mode from tool name (e.g., 'promptManager-executePrompt' -> 'executePrompt')
        const mode = toolName.replace('promptManager-', '');
        
        // Enhance based on the mode
        switch (mode) {
            case 'executePrompt':
            case 'batchExecutePrompt':
                this.enhanceExecutePromptSchema(enhanced, data);
                break;
            case 'createPrompt':
            case 'updatePrompt':
            case 'getPrompt':
            case 'deletePrompt':
            case 'togglePrompt':
                this.enhancePromptManagementSchema(enhanced, data);
                break;
            case 'listPrompts':
                this.enhanceListPromptsSchema(enhanced, data);
                break;
            default:
                // For other modes, add general context
                this.enhanceGeneralSchema(enhanced, data);
                break;
        }
        
        this.logEnhancement(toolName, 'injected agent and prompt context', {
            agentsCount: data.agents.length,
            promptsCount: data.prompts.length
        });
        
        return enhanced;
    }

    /**
     * Enhance executePrompt and batchExecutePrompt schemas
     */
    private enhanceExecutePromptSchema(schema: EnhancedJSONSchema, data: CachedData): void {
        // Enhance agent parameter with available agent names
        if (schema.properties?.agent) {
            const agentProp = schema.properties.agent as EnhancedJSONSchema;
            agentProp.enum = data.agents
                .filter(agent => agent.enabled)
                .slice(0, this.MAX_AGENTS_TO_SHOW)
                .map(agent => agent.name);

            agentProp.description = this.buildAgentDescription(data.agents);

            // Add examples
            const enabledAgents = data.agents.filter(agent => agent.enabled);
            if (enabledAgents.length > 0) {
                agentProp.examples = enabledAgents.slice(0, 3).map(agent => agent.name);
            }
        }

        // Add prompt ID parameter if not present
        if (schema.properties && !schema.properties.promptId && data.prompts.length > 0) {
            schema.properties.promptId = {
                type: 'string',
                description: this.buildPromptIdDescription(data.prompts),
                enum: data.prompts
                    .filter(prompt => prompt.enabled)
                    .slice(0, this.MAX_PROMPTS_TO_SHOW)
                    .map(prompt => prompt.id),
                examples: data.prompts
                    .filter(prompt => prompt.enabled)
                    .slice(0, 3)
                    .map(prompt => prompt.id)
            };
        }

        // Update tool description with agent and prompt context
        if (data.agents.length > 0 || data.prompts.length > 0) {
            schema.description = `${schema.description}\n\n${this.buildContextSummary(data)}`;
        }
    }

    /**
     * Enhance prompt management schemas (create, update, get, delete, toggle)
     */
    private enhancePromptManagementSchema(schema: EnhancedJSONSchema, data: CachedData): void {
        // For ID-based operations, enhance with available prompt IDs
        if (schema.properties?.id && data.prompts.length > 0) {
            const idProp = schema.properties.id as EnhancedJSONSchema;
            idProp.enum = data.prompts.map(prompt => prompt.id);
            idProp.description = `${idProp.description || 'Prompt ID'}\n\nAvailable prompt IDs:\n${
                data.prompts.map(prompt => `• ${prompt.id}: ${prompt.name} ${prompt.enabled ? '✅' : '❌'}`).join('\n')
            }`;
        }

        // For name-based operations, enhance with available prompt names
        if (schema.properties?.name && data.prompts.length > 0) {
            const nameProp = schema.properties.name as EnhancedJSONSchema;
            nameProp.enum = data.prompts.map(prompt => prompt.name);
            nameProp.examples = data.prompts.slice(0, 3).map(prompt => prompt.name);
        }
    }

    /**
     * Enhance listPrompts schema
     */
    private enhanceListPromptsSchema(schema: EnhancedJSONSchema, data: CachedData): void {
        if (data.prompts.length > 0) {
            schema.description = `${schema.description}\n\nCurrent prompts: ${data.prompts.length} total (${
                data.prompts.filter(p => p.enabled).length
            } enabled)`;
        }
    }

    /**
     * Enhance general schemas with basic context
     */
    private enhanceGeneralSchema(schema: EnhancedJSONSchema, data: CachedData): void {
        if (data.agents.length > 0 || data.prompts.length > 0) {
            schema.description = `${schema.description}\n\n${this.buildContextSummary(data)}`;
        }
    }

    /**
     * Build agent parameter description with available agents
     */
    private buildAgentDescription(agents: AgentInfo[]): string {
        const enabledAgents = agents.filter(agent => agent.enabled);
        
        if (enabledAgents.length === 0) {
            return 'Agent name to use for prompt execution. No custom prompt agents currently available.';
        }
        
        const agentsList = enabledAgents
            .slice(0, this.MAX_AGENTS_TO_SHOW)
            .map(agent => `• ${agent.name}: ${agent.description || 'No description'}`)
            .join('\n');
        
        return `Agent name to use for prompt execution. Available custom prompt agents:\n${agentsList}${
            enabledAgents.length > this.MAX_AGENTS_TO_SHOW ? '\n...and more' : ''
        }`;
    }

    /**
     * Build prompt ID parameter description with available prompts
     */
    private buildPromptIdDescription(prompts: PromptInfo[]): string {
        const enabledPrompts = prompts.filter(prompt => prompt.enabled);
        
        if (enabledPrompts.length === 0) {
            return 'Custom prompt ID to execute directly (alternative to specifying agent). No custom prompts currently available.';
        }
        
        const promptsList = enabledPrompts
            .slice(0, this.MAX_PROMPTS_TO_SHOW)
            .map(prompt => `• ${prompt.id}: ${prompt.name} - ${prompt.description || 'No description'}`)
            .join('\n');
        
        return `Custom prompt ID to execute directly (alternative to specifying agent). Available custom prompts:\n${promptsList}${
            enabledPrompts.length > this.MAX_PROMPTS_TO_SHOW ? '\n...and more' : ''
        }`;
    }

    /**
     * Build context summary for tool descriptions
     */
    private buildContextSummary(data: CachedData): string {
        const parts: string[] = [];
        
        const enabledAgents = data.agents.filter(agent => agent.enabled);
        if (enabledAgents.length > 0) {
            parts.push(`Available agents: ${enabledAgents.length} enabled`);
        }
        
        const enabledPrompts = data.prompts.filter(prompt => prompt.enabled);
        if (enabledPrompts.length > 0) {
            parts.push(`Custom prompts: ${enabledPrompts.length} enabled`);
        }
        
        if (parts.length === 0) {
            return 'No custom agents or prompts currently available.';
        }
        
        return `🤖 ${parts.join(' | ')}`;
    }

    /**
     * Get cached data or refresh if stale
     */
    private async getCachedData(): Promise<CachedData> {
        const now = Date.now();
        
        if (this.cache && (now - this.cache.timestamp) < this.CACHE_DURATION_MS) {
            return this.cache;
        }
        
        // Refresh cache
        const agents = await this.queryAvailableAgents();
        const prompts = await this.queryAvailablePrompts();
        
        this.cache = {
            agents,
            prompts,
            timestamp: now
        };
        
        return this.cache;
    }

    /**
     * Query available agents from the agents map
     */
    private async queryAvailableAgents(): Promise<AgentInfo[]> {
        if (!this.agentsMap) {
            return [];
        }
        
        try {
            const agents: AgentInfo[] = [];
            
            for (const [name, agent] of this.agentsMap.entries()) {
                // Skip the PromptManager agent itself to avoid confusion
                if (name === 'promptManager') {
                    continue;
                }
                
                agents.push({
                    name,
                    description: agent.description || 'No description available',
                    enabled: true // Regular agents are always considered enabled
                });
            }
            
            return agents;
        } catch (error) {
            logger.systemError(error as Error, `${this.name} - Error querying available agents`);
            return [];
        }
    }

    /**
     * Query available custom prompts from storage service
     */
    private async queryAvailablePrompts(): Promise<PromptInfo[]> {
        if (!this.customPromptStorage) {
            return [];
        }
        
        try {
            // Check if custom prompts are enabled globally
            if (!this.customPromptStorage.isEnabled()) {
                return [];
            }
            
            const allPrompts = this.customPromptStorage.getAllPrompts();
            
            return allPrompts.map(prompt => ({
                id: prompt.id,
                name: prompt.name,
                description: prompt.description || 'No description available',
                enabled: prompt.isEnabled
            }));
        } catch (error) {
            logger.systemError(error as Error, `${this.name} - Error querying available prompts`);
            return [];
        }
    }

    /**
     * Clear cache (useful when agents or prompts change)
     */
    private clearCache(): void {
        this.cache = null;
    }
}