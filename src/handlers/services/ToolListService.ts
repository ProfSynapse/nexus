import { NexusError, NexusErrorCode } from '../../utils/errors';
import { IToolListService, ISchemaEnhancementService } from '../interfaces/IRequestHandlerServices';
import { IAgent } from '../../agents/interfaces/IAgent';
import { logger } from '../../utils/logger';

interface AgentSchema {
    type: string;
    properties: {
        tool: {
            type: string;
            enum: string[];
            description: string;
        };
        [key: string]: unknown;
    };
    required: string[];
    allOf: unknown[];
}

export class ToolListService implements IToolListService {
    private schemaEnhancementService?: ISchemaEnhancementService;
    async generateToolList(
        agents: Map<string, IAgent>,
        isVaultEnabled: boolean,
        vaultName?: string
    ): Promise<{ tools: any[] }> {
        try {
            if (!isVaultEnabled) {
                return { tools: [] };
            }
            
            const tools: any[] = [];
            
            for (const agent of agents.values()) {
                const agentSchema = this.buildAgentSchema(agent);
                this.mergeToolSchemasIntoAgent(agent, agentSchema);

                // Use agent name directly - vault context is already provided by IPC connection
                // No need to add vault suffix which causes parsing issues with vault names containing underscores
                const toolName = agent.name;
                
                // Enhance the schema and description if enhancement service is available
                let finalSchema = agentSchema;
                let finalDescription = agent.description;
                
                if (this.schemaEnhancementService) {
                    try {
                        // Cast to our enhanced interface if available
                        const enhancedService = this.schemaEnhancementService as ISchemaEnhancementService & { enhanceAgentDescription?: (agent: IAgent, vaultName?: string) => Promise<string> };

                        // Enhance schema with agent context
                        finalSchema = await this.schemaEnhancementService.enhanceToolSchema(
                            toolName,
                            agentSchema
                        );

                        // Enhance description if the service supports it
                        if (enhancedService.enhanceAgentDescription) {
                            finalDescription = await enhancedService.enhanceAgentDescription(agent, vaultName);
                        }
                    } catch (error) {
                        logger.systemError(error as Error, `Error enhancing schema for ${toolName}`);
                        // Use original schema and description on enhancement failure
                        finalSchema = agentSchema;
                        finalDescription = agent.description;
                    }
                }
                
                // Clean up the schema - remove empty allOf arrays
                // Claude API doesn't support allOf/oneOf/anyOf at top level
                const cleanedSchema = this.cleanSchema(finalSchema);

                tools.push({
                    name: toolName,
                    description: finalDescription,
                    inputSchema: cleanedSchema
                });
            }

            return { tools };
        } catch (error) {
            logger.systemError(error as Error, "Error in generateToolList");
            throw new NexusError(NexusErrorCode.InternalError, 'Failed to list tools', error);
        }
    }

    buildAgentSchema(agent: IAgent): AgentSchema {
        return {
            type: 'object',
            properties: {
                tool: {
                    type: 'string',
                    enum: [] as string[],
                    description: 'The tool to execute on this agent'
                },
                sessionId: {
                    type: 'string',
                    description: 'Session identifier to track related tool calls'
                }
            },
            required: ['tool', 'sessionId'],
            allOf: []
        };
    }

    mergeToolSchemasIntoAgent(agent: IAgent, agentSchema: AgentSchema): AgentSchema {
        const agentTools = agent.getTools();

        for (const tool of agentTools) {
            agentSchema.properties.tool.enum.push(tool.slug);

            try {
                const toolSchema = tool.getParameterSchema();

                if (toolSchema && typeof toolSchema === 'object') {
                    const toolSchemaCopy = JSON.parse(JSON.stringify(toolSchema)) as Record<string, unknown>;

                    if (toolSchemaCopy.properties && typeof toolSchemaCopy.properties === 'object') {
                        const props = toolSchemaCopy.properties as Record<string, unknown>;
                        if (props.tool) {
                            delete props.tool;
                        }
                    }

                    if (toolSchemaCopy.required && Array.isArray(toolSchemaCopy.required) && toolSchemaCopy.required.length > 0) {
                        const conditionalRequired = (toolSchemaCopy.required as string[]).filter(
                            (prop: string) => prop !== 'tool' && prop !== 'sessionId'
                        );

                        if (conditionalRequired.length > 0) {
                            agentSchema.allOf.push({
                                if: {
                                    properties: {
                                        tool: { enum: [tool.slug] }
                                    }
                                },
                                then: {
                                    required: conditionalRequired
                                }
                            });
                        }
                    }

                    if (toolSchemaCopy.properties && typeof toolSchemaCopy.properties === 'object') {
                        const props = toolSchemaCopy.properties as Record<string, unknown>;
                        for (const [propName, propSchema] of Object.entries(props)) {
                            if (propName !== 'tool' && propName !== 'sessionId') {
                                agentSchema.properties[propName] = propSchema;
                            }
                        }
                    }

                    ['allOf', 'anyOf', 'oneOf', 'not'].forEach(validationType => {
                        if (toolSchemaCopy[validationType]) {
                            agentSchema.allOf.push({
                                if: {
                                    properties: {
                                        tool: { enum: [tool.slug] }
                                    }
                                },
                                then: {
                                    [validationType]: toolSchemaCopy[validationType]
                                }
                            });
                        }
                    });
                }
            } catch (error) {
                logger.systemError(error as Error, `Error processing schema for tool ${tool.slug}`);
            }
        }

        return agentSchema;
    }

    /**
     * @deprecated Use mergeToolSchemasIntoAgent instead
     */
    mergeModeSchemasIntoAgent(agent: IAgent, agentSchema: AgentSchema): AgentSchema {
        return this.mergeToolSchemasIntoAgent(agent, agentSchema);
    }

    setSchemaEnhancementService(service: ISchemaEnhancementService): void {
        this.schemaEnhancementService = service;
    }

    /**
     * Clean schema to be compatible with Claude's API
     * Remove allOf/oneOf/anyOf at top level if empty or move conditionals to description
     */
    private cleanSchema(schema: any): any {
        const cleaned = { ...schema };

        // Remove allOf if it's empty
        if (cleaned.allOf && Array.isArray(cleaned.allOf) && cleaned.allOf.length === 0) {
            delete cleaned.allOf;
        }

        // If allOf has items, we need to flatten them or remove them
        // Claude API doesn't support conditional schemas at top level
        if (cleaned.allOf && Array.isArray(cleaned.allOf) && cleaned.allOf.length > 0) {
            // For now, just remove allOf - mode-specific validation will happen server-side
            // We keep all properties merged, just remove the conditional required fields
            delete cleaned.allOf;
        }

        return cleaned;
    }
}