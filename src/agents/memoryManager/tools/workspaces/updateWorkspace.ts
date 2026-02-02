/**
 * Location: /src/agents/memoryManager/modes/workspaces/UpdateWorkspaceMode.ts
 * Purpose: Update existing workspace properties and context
 *
 * Supports partial updates - pass only the fields you want to change.
 * Context fields can be updated individually without replacing the entire context.
 *
 * Used by: MemoryManager agent for workspace modification operations
 */

import { App } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { MemoryManagerAgent } from '../../memoryManager';
import { createServiceIntegration } from '../../services/ValidationService';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { CommonResult, CommonParameters } from '../../../../types/mcp/AgentTypes';

// Define parameter and result types for workspace updates
export interface UpdateWorkspaceParameters extends CommonParameters {
    workspaceId: string;
    // Top-level fields (all optional)
    name?: string;
    description?: string;
    rootFolder?: string;
    // Context fields (all optional) - merged individually
    purpose?: string;
    workflows?: Array<{ name: string; when: string; steps: string }>;
    keyFiles?: string[];
    preferences?: string;
    dedicatedAgentId?: string;
}

export interface UpdateWorkspaceResult extends CommonResult {
    success: boolean;
    error?: string;
}

/**
 * UpdateWorkspaceMode - Modify existing workspace properties
 * Pass only the fields you want to update; others remain unchanged.
 */
export class UpdateWorkspaceTool extends BaseTool<UpdateWorkspaceParameters, UpdateWorkspaceResult> {
    private app: App;
    private serviceIntegration: ReturnType<typeof createServiceIntegration>;

    constructor(private agent: MemoryManagerAgent) {
        super(
            'updateWorkspace',
            'Update Workspace',
            'Update workspace properties. Pass only fields to change - others remain unchanged.',
            '2.0.0'
        );

        this.app = agent.getApp();
        this.serviceIntegration = createServiceIntegration(this.app, {
            logLevel: 'warn',
            maxRetries: 2,
            fallbackBehavior: 'warn'
        });
    }

    async execute(params: UpdateWorkspaceParameters): Promise<UpdateWorkspaceResult> {
        try {
            // Get workspace service
            const serviceResult = await this.serviceIntegration.getWorkspaceService();
            if (!serviceResult.success || !serviceResult.service) {
                return this.prepareResult(false, undefined, `Workspace service not available: ${serviceResult.error}`);
            }

            const workspaceService = serviceResult.service;

            // Validate workspace exists using unified lookup (ID or name)
            const existingWorkspace = await workspaceService.getWorkspaceByNameOrId(params.workspaceId);
            if (!existingWorkspace) {
                return this.prepareResult(false, undefined, `Workspace "${params.workspaceId}" not found. Use listWorkspaces to see available workspaces.`);
            }

            // Check that at least one field is being updated
            const hasTopLevelUpdates = params.name !== undefined ||
                                       params.description !== undefined ||
                                       params.rootFolder !== undefined;
            const hasContextUpdates = params.purpose !== undefined ||
                                      params.workflows !== undefined ||
                                      params.keyFiles !== undefined ||
                                      params.preferences !== undefined ||
                                      params.dedicatedAgentId !== undefined;

            if (!hasTopLevelUpdates && !hasContextUpdates) {
                return this.prepareResult(false, undefined, 'No updates provided. Pass at least one field to update (name, description, rootFolder, purpose, workflows, keyFiles, preferences, or dedicatedAgentId).');
            }

            // Handle dedicated agent setup
            let dedicatedAgent: { agentId: string; agentName: string } | undefined = undefined;
            if (params.dedicatedAgentId) {
                try {
                    // Get the agent name from CustomPromptStorageService
                    const plugin = this.app.plugins.getPlugin('claudesidian-mcp') as unknown as Record<string, unknown> | null;
                    const agentManager = plugin?.agentManager as Record<string, unknown> | undefined;
                    if (agentManager?.getAgent) {
                        const getAgent = agentManager.getAgent as (name: string) => Record<string, unknown> | undefined;
                        const promptManagerAgent = getAgent('promptManager');
                        const storageService = promptManagerAgent?.storageService as Record<string, unknown> | undefined;
                        if (storageService?.getPromptByNameOrId) {
                            const getPromptByNameOrId = storageService.getPromptByNameOrId as (identifier: string) => { id: string; name: string } | undefined;
                            const agent = getPromptByNameOrId(params.dedicatedAgentId);
                            if (agent) {
                                dedicatedAgent = {
                                    agentId: agent.id,
                                    agentName: agent.name
                                };
                            } else {
                                console.error('[UpdateWorkspace] Dedicated agent not found:', params.dedicatedAgentId);
                            }
                        }
                    }
                } catch (error) {
                    console.error('[UpdateWorkspace] Failed to resolve dedicated agent:', params.dedicatedAgentId, error);
                    // Ignore agent name retrieval errors
                }
            }

            console.error('[UpdateWorkspace] DedicatedAgent resolved:', JSON.stringify(dedicatedAgent));

            // Create a deep copy for updating
            const workspaceCopy = JSON.parse(JSON.stringify(existingWorkspace));
            const now = Date.now();

            // Apply top-level updates
            if (params.name !== undefined) {
                workspaceCopy.name = params.name;
            }
            if (params.description !== undefined) {
                workspaceCopy.description = params.description;
            }
            if (params.rootFolder !== undefined) {
                // Ensure folder exists
                try {
                    const folder = this.app.vault.getAbstractFileByPath(params.rootFolder);
                    if (!folder) {
                        await this.app.vault.createFolder(params.rootFolder);
                    }
                } catch (folderError) {
                    // Ignore folder creation errors
                }
                workspaceCopy.rootFolder = params.rootFolder;
            }

            // Initialize context if it doesn't exist
            if (!workspaceCopy.context) {
                workspaceCopy.context = {};
            }

            // Apply context-level updates (merged individually)
            if (params.purpose !== undefined) {
                workspaceCopy.context.purpose = params.purpose;
            }
            if (params.workflows !== undefined) {
                workspaceCopy.context.workflows = params.workflows;
            }
            if (params.keyFiles !== undefined) {
                workspaceCopy.context.keyFiles = params.keyFiles;
            }
            if (params.preferences !== undefined) {
                workspaceCopy.context.preferences = params.preferences;
            }
            if (params.dedicatedAgentId !== undefined) {
                if (params.dedicatedAgentId === '') {
                    // Empty string means remove dedicated agent
                    delete workspaceCopy.context.dedicatedAgent;
                    (workspaceCopy as any).dedicatedAgentId = undefined; // Also clear top-level field
                } else if (dedicatedAgent) {
                    // Set dedicated agent if lookup succeeded
                    workspaceCopy.context.dedicatedAgent = dedicatedAgent;
                    (workspaceCopy as any).dedicatedAgentId = dedicatedAgent.agentId; // Also set top-level field
                }
            }

            // Update timestamp
            workspaceCopy.lastAccessed = now;

            console.error('[UpdateWorkspace] Updating with context.dedicatedAgent:', JSON.stringify(workspaceCopy.context?.dedicatedAgent));

            // Perform the update
            await workspaceService.updateWorkspace(existingWorkspace.id, workspaceCopy);

            // Success - LLM already knows what it passed
            return this.prepareResult(true);

        } catch (error) {
            return this.prepareResult(false, undefined, createErrorMessage('Error updating workspace: ', error));
        }
    }

    getParameterSchema(): Record<string, unknown> {
        const toolSchema = {
            type: 'object',
            properties: {
                workspaceId: {
                    type: 'string',
                    description: 'ID or name of the workspace to update (REQUIRED)'
                },
                // Top-level optional fields
                name: {
                    type: 'string',
                    description: 'New workspace name (optional)'
                },
                description: {
                    type: 'string',
                    description: 'New workspace description (optional)'
                },
                rootFolder: {
                    type: 'string',
                    description: 'New root folder path (optional, will create if needed)'
                },
                // Context optional fields
                purpose: {
                    type: 'string',
                    description: 'New workspace purpose (optional, updates context.purpose)'
                },
                workflows: {
                    type: 'array',
                    description: 'New workflows array (optional, replaces context.workflows)',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            when: { type: 'string' },
                            steps: { type: 'string' }
                        },
                        required: ['name', 'when', 'steps']
                    }
                },
                keyFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'New key files array (optional, replaces context.keyFiles)'
                },
                preferences: {
                    type: 'string',
                    description: 'New preferences text (optional, updates context.preferences)'
                },
                dedicatedAgentId: {
                    type: 'string',
                    description: 'ID of custom agent to set as workspace dedicated agent (optional, updates context.dedicatedAgent). Pass empty string to remove dedicated agent.'
                }
            },
            required: ['workspaceId']
        };

        return this.getMergedSchema(toolSchema);
    }

    getResultSchema(): Record<string, unknown> {
        return {
            type: 'object',
            properties: {
                success: { type: 'boolean', description: 'Whether the operation succeeded' },
                error: { type: 'string', description: 'Error message if failed (includes recovery guidance)' }
            },
            required: ['success']
        };
    }
}
