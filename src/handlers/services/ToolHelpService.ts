import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IToolHelpService } from '../interfaces/IRequestHandlerServices';
import { IAgent } from '../../agents/interfaces/IAgent';
import { logger } from '../../utils/logger';
import {
    generateToolHelp,
    formatToolHelp
} from '../../utils/parameterHintUtils';

/**
 * Help content interface for MCP tool help
 */
interface HelpContent {
    type: string;
    text: string;
}

/**
 * Service for generating tool help content
 * Applies Single Responsibility Principle by focusing solely on help generation
 */
export class ToolHelpService implements IToolHelpService {
    constructor() {}

    /**
     * Generate help content for a specific agent mode
     * @param getAgent Function to retrieve agent by name
     * @param toolName Full tool name (may include vault suffix)
     * @param mode Mode name to get help for
     * @returns Promise resolving to help content
     */
    async generateToolHelp(
        getAgent: (name: string) => IAgent,
        toolName: string,
        mode: string
    ): Promise<{ content: HelpContent[] }> {
        try {
            logger.systemLog(`ToolHelpService: Generating help for tool ${toolName}, mode ${mode}`);
            
            // Extract agent name from tool name (removes vault suffix if present)
            const agentName = this.extractAgentName(toolName);
            
            // Validate mode parameter
            if (!mode) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Missing required parameter: mode for help on agent ${agentName}`
                );
            }
            
            // Get the agent
            const agent = getAgent(agentName);
            if (!agent) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Agent ${agentName} not found`
                );
            }
            
            // Get the tool instance
            const toolInstance = agent.getTool(mode);
            if (!toolInstance) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Tool ${mode} not found in agent ${agentName}`
                );
            }

            // Get the tool's parameter schema
            const schema = toolInstance.getParameterSchema();

            // Generate help content
            const help = generateToolHelp(
                mode,
                toolInstance.description,
                schema
            );

            // Format the help text
            const helpText = formatToolHelp(help);
            
            logger.systemLog(`ToolHelpService: Generated help for ${agentName}_${mode}`);
            
            return {
                content: [{
                    type: "text",
                    text: helpText
                }]
            };
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            logger.systemError(error as Error, 'ToolHelpService');
            throw new McpError(ErrorCode.InternalError, 'Failed to get tool help', error);
        }
    }

    /**
     * Generate help for all modes of an agent (future enhancement)
     * @param getAgent Function to retrieve agent by name
     * @param toolName Full tool name
     * @returns Promise resolving to comprehensive help content
     */
    async generateAgentHelp(
        getAgent: (name: string) => IAgent,
        toolName: string
    ): Promise<{ content: HelpContent[] }> {
        try {
            const agentName = this.extractAgentName(toolName);
            const agent = getAgent(agentName);
            
            if (!agent) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Agent ${agentName} not found`
                );
            }
            
            const tools = agent.getTools().map(tool => tool.slug);
            const helpContent: HelpContent[] = [];

            // Add agent overview
            helpContent.push({
                type: "text",
                text: `# ${agentName} Agent\n\n${agent.description}\n\n## Available Tools:\n`
            });

            // Add help for each tool
            for (const toolSlug of tools) {
                try {
                    const toolHelpContent = await this.generateToolHelp(getAgent, toolName, toolSlug);
                    helpContent.push(...toolHelpContent.content);
                    helpContent.push({
                        type: "text",
                        text: "\n---\n"
                    });
                } catch (error) {
                    logger.systemWarn(`ToolHelpService: Failed to generate help for tool ${toolSlug}`);
                }
            }
            
            return { content: helpContent };
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            logger.systemError(error as Error, 'ToolHelpService');
            throw new McpError(ErrorCode.InternalError, 'Failed to get agent help', error);
        }
    }

    /**
     * Extract the agent name from a tool name that may have a vault name suffix
     * @param toolName Tool name (e.g., "contentManager_vaultName" or "contentManager")
     * @returns Agent name without vault suffix
     * @private
     */
    private extractAgentName(toolName: string): string {
        const lastUnderscoreIndex = toolName.lastIndexOf('_');
        
        if (lastUnderscoreIndex === -1) {
            // No underscore found, return the tool name as-is
            return toolName;
        }
        
        // Extract everything before the last underscore as the agent name
        return toolName.substring(0, lastUnderscoreIndex);
    }

    /**
     * Validate if tool exists for agent (utility method)
     * @param getAgent Function to retrieve agent by name
     * @param toolName Full tool name
     * @param toolSlug Tool slug to validate
     * @returns Promise resolving to boolean
     */
    async validateToolExists(
        getAgent: (name: string) => IAgent,
        toolName: string,
        toolSlug: string
    ): Promise<boolean> {
        try {
            const agentName = this.extractAgentName(toolName);
            const agent = getAgent(agentName);

            if (!agent) {
                return false;
            }

            const toolInstance = agent.getTool(toolSlug);
            return toolInstance !== undefined;
        } catch (error) {
            logger.systemWarn(`ToolHelpService: Tool validation failed for ${toolName}.${toolSlug}`);
            return false;
        }
    }

    /**
     * @deprecated Use validateToolExists instead
     */
    async validateModeExists(
        getAgent: (name: string) => IAgent,
        toolName: string,
        mode: string
    ): Promise<boolean> {
        return this.validateToolExists(getAgent, toolName, mode);
    }
}