import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IToolHelpService } from '../interfaces/IRequestHandlerServices';
import { IAgent } from '../../agents/interfaces/IAgent';
import { logger } from '../../utils/logger';
import {
    generateModeHelp,
    formatModeHelp
} from '../../utils/parameterHintUtils';
import { parseAgentToolName } from '../../utils/toolNameUtils';

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
            const agentName = parseAgentToolName(toolName).agentName;
            
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
            
            // Get the mode instance
            const modeInstance = agent.getMode(mode);
            if (!modeInstance) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Mode ${mode} not found in agent ${agentName}`
                );
            }
            
            // Get the mode's parameter schema
            const schema = modeInstance.getParameterSchema();
            
            // Generate help content
            const help = generateModeHelp(
                mode,
                modeInstance.description,
                schema
            );
            
            // Format the help text
            const helpText = formatModeHelp(help);
            
            logger.systemLog(`ToolHelpService: Generated help for ${agentName}.${mode}`);
            
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
            const agentName = parseAgentToolName(toolName).agentName;
            const agent = getAgent(agentName);
            
            if (!agent) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Agent ${agentName} not found`
                );
            }
            
            const modes = agent.getModes().map(mode => mode.slug);
            const helpContent: HelpContent[] = [];
            
            // Add agent overview
            helpContent.push({
                type: "text",
                text: `# ${agentName} Agent\n\n${agent.description}\n\n## Available Modes:\n`
            });
            
            // Add help for each mode
            for (const modeName of modes) {
                try {
                    const modeHelp = await this.generateToolHelp(getAgent, toolName, modeName);
                    helpContent.push(...modeHelp.content);
                    helpContent.push({
                        type: "text",
                        text: "\n---\n"
                    });
                } catch (error) {
                    logger.systemWarn(`ToolHelpService: Failed to generate help for mode ${modeName}`);
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
    /**
     * Validate if mode exists for agent (utility method)
     * @param getAgent Function to retrieve agent by name
     * @param toolName Full tool name
     * @param mode Mode name to validate
     * @returns Promise resolving to boolean
     */
    async validateModeExists(
        getAgent: (name: string) => IAgent,
        toolName: string,
        mode: string
    ): Promise<boolean> {
        try {
            const agentName = parseAgentToolName(toolName).agentName;
            const agent = getAgent(agentName);
            
            if (!agent) {
                return false;
            }
            
            const modeInstance = agent.getMode(mode);
            return modeInstance !== undefined;
        } catch (error) {
            logger.systemWarn(`ToolHelpService: Mode validation failed for ${toolName}.${mode}`);
            return false;
        }
    }
}
