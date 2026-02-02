import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
/**
 * Location: /src/agents/memoryManager/modes/workspaces/CreateWorkspaceMode.ts
 * Purpose: Consolidated workspace creation tool
 *
 * This file consolidates the original createWorkspaceMode.ts functionality
 *
 * Used by: MemoryManager agent for workspace creation operations
 */

import { App } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { MemoryManagerAgent } from '../../memoryManager'
import { createServiceIntegration } from '../../services/ValidationService';

// Import types from existing workspace mode
import { 
    CreateWorkspaceParameters, 
    CreateWorkspaceResult
} from '../../../../database/types/workspace/ParameterTypes';
import { ProjectWorkspace, WorkspaceContext } from '../../../../database/types/workspace/WorkspaceTypes';
import { WorkspaceService } from '../../../../services/WorkspaceService';
import { createErrorMessage } from '../../../../utils/errorUtils';

/**
 * Consolidated CreateWorkspaceMode - simplified from original
 */
export class CreateWorkspaceTool extends BaseTool<CreateWorkspaceParameters, CreateWorkspaceResult> {
    private app: App;
    private serviceIntegration: ReturnType<typeof createServiceIntegration>;
    
    constructor(private agent: MemoryManagerAgent) {
        super(
            'createWorkspace',
            'Create Workspace',
            'Create a new workspace with structured context data',
            '2.0.0'
        );

        this.app = agent.getApp();
        this.serviceIntegration = createServiceIntegration(this.app, {
            logLevel: 'warn',
            maxRetries: 2,
            fallbackBehavior: 'warn'
        });
    }
    
    async execute(params: CreateWorkspaceParameters): Promise<CreateWorkspaceResult> {
        try {
            // Get workspace service
            const serviceResult = await this.serviceIntegration.getWorkspaceService();
            if (!serviceResult.success || !serviceResult.service) {
                return this.prepareResult(false, undefined, `Workspace service not available: ${serviceResult.error}`);
            }
            
            const workspaceService = serviceResult.service;
            
            // Validate required fields
            if (!params.name) {
                return this.prepareResult(false, undefined, 'Name is required. Provide a descriptive workspace name.');
            }
            if (!params.description) {
                return this.prepareResult(false, undefined, 'Description is required. Provide a brief description of what this workspace is for.');
            }
            if (!params.rootFolder) {
                return this.prepareResult(false, undefined, 'Root folder is required. Specify the vault folder path for this workspace.');
            }
            if (!params.purpose) {
                return this.prepareResult(false, undefined, 'Purpose is required. Describe what this workspace is used for.');
            }
            
            // Ensure root folder exists
            try {
                const folder = this.app.vault.getAbstractFileByPath(params.rootFolder);
                if (!folder) {
                    await this.app.vault.createFolder(params.rootFolder);
                }
            } catch (folderError) {
                // Ignore folder creation errors
            }
            
            // Store dedicatedAgentId as-is (name or ID)
            // Lookup will happen in WorkspacePromptResolver when loading (which runs in plugin context)
            console.error('[CreateWorkspace] Storing dedicatedAgentId:', params.dedicatedAgentId);

            // Combine provided key files with auto-detected ones
            const providedKeyFiles = params.keyFiles || [];
            const autoDetectedKeyFiles = await this.detectSimpleKeyFiles(params.rootFolder);
            const allKeyFiles = [...new Set([...providedKeyFiles, ...autoDetectedKeyFiles])]; // Remove duplicates

            // Build workspace context (don't include dedicatedAgent object yet - will be resolved on load)
            const context: WorkspaceContext = {
                purpose: params.purpose,
                workflows: params.workflows,
                keyFiles: allKeyFiles,
                preferences: params.preferences || ''
            };

            console.error('[CreateWorkspace] Creating workspace with dedicatedAgentId:', params.dedicatedAgentId);

            // Create workspace data
            const now = Date.now();
            const workspaceData: Omit<ProjectWorkspace, 'id'> & { dedicatedAgentId?: string } = {
                name: params.name,
                context: context,
                rootFolder: params.rootFolder,
                created: now,
                lastAccessed: now,
                description: params.description,
                dedicatedAgentId: params.dedicatedAgentId, // Store ID or name as-is
                relatedFolders: params.relatedFolders || [],
                relatedFiles: params.relatedFiles || [],
                associatedNotes: [],
                keyFileInstructions: params.keyFileInstructions,
                activityHistory: [{
                    timestamp: now,
                    action: 'create',
                    toolName: 'CreateWorkspaceMode',
                    context: `Created workspace: ${params.purpose}`
                }],
                preferences: undefined, // Legacy field - preferences now stored in context
                projectPlan: undefined,
                checkpoints: [],
                completionStatus: {}
            };
            
            // Check if workspace with same name already exists
            try {
                const existing = await workspaceService.getWorkspaceByNameOrId(params.name);
                if (existing) {
                    return this.prepareResult(false, undefined, `Workspace "${params.name}" already exists. Use listWorkspaces to see existing workspaces.`);
                }
            } catch (error) {
                // Ignore lookup errors
            }

            // Save workspace
            await workspaceService.createWorkspace(workspaceData);

            // Success - LLM already knows the workspace details it passed
            return this.prepareResult(true);

        } catch (error) {
            return this.prepareResult(false, undefined, createErrorMessage('Error creating workspace: ', error));
        }
    }
    
    /**
     * Auto-detect key files in workspace folder (simple array format)
     */
    private async detectSimpleKeyFiles(rootFolder: string): Promise<string[]> {
        try {
            const detectedFiles: string[] = [];

            const folder = this.app.vault.getAbstractFileByPath(rootFolder);
            if (folder && 'children' in folder && Array.isArray(folder.children)) {
                for (const child of folder.children as Array<{ path: string; name: string; cachedData?: { frontmatter?: { key?: boolean } } }>) {
                    if (child.path.endsWith('.md')) {
                        const fileName = child.name.toLowerCase();

                        // Auto-detect common key files
                        if (['index.md', 'readme.md', 'summary.md', 'moc.md', 'overview.md'].includes(fileName)) {
                            detectedFiles.push(child.path);
                        }

                        try {
                            // Check for frontmatter key: true
                            if ('cachedData' in child && child.cachedData?.frontmatter?.key === true) {
                                detectedFiles.push(child.path);
                            }
                        } catch (error) {
                            // Ignore frontmatter parsing errors
                        }
                    }
                }
            }

            return detectedFiles;

        } catch (error) {
            return [];
        }
    }

    getParameterSchema(): JSONSchema {
        const toolSchema = {
            type: 'object',
            title: 'Create Workspace',
            description: 'Create a new workspace with structured workflows and context.',
            properties: {
                name: {
                    type: 'string',
                    description: 'Workspace name'
                },
                description: {
                    type: 'string',
                    description: 'Brief description of the workspace purpose'
                },
                rootFolder: {
                    type: 'string',
                    description: 'Root folder path for this workspace'
                },
                purpose: {
                    type: 'string',
                    description: 'Overall purpose and goals for this workspace'
                },
                workflows: {
                    type: 'array',
                    description: 'Workflows for different situations. Each workflow has name, when (trigger), and steps (newline-separated string).',
                    items: {
                        type: 'object',
                        properties: {
                            name: {
                                type: 'string',
                                description: 'Workflow name'
                            },
                            when: {
                                type: 'string',
                                description: 'When to use this workflow'
                            },
                            steps: {
                                type: 'string',
                                description: 'Steps separated by newline characters (\\n)'
                            }
                        },
                        required: ['name', 'when', 'steps']
                    },
                    minItems: 1
                },
                keyFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Key file paths for quick reference'
                },
                preferences: {
                    type: 'string',
                    description: 'User preferences or workspace settings'
                },
                dedicatedAgentId: {
                    type: 'string',
                    description: 'ID of dedicated prompt for this workspace'
                },
                relatedFolders: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Related folder paths'
                },
                relatedFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Related file paths'
                },
                keyFileInstructions: {
                    type: 'string',
                    description: 'Instructions for working with key files'
                }
            },
            required: ['name', 'description', 'rootFolder', 'purpose'],
            errorHelp: {
                missingName: 'The "name" parameter is required. Provide a descriptive workspace name.',
                missingDescription: 'The "description" parameter is required. Provide a brief description.',
                missingRootFolder: 'The "rootFolder" parameter is required. Specify the folder path for this workspace.',
                missingPurpose: 'The "purpose" parameter is required. Describe what this workspace is for.',
                workflowStepsFormat: 'CRITICAL: workflow "steps" should be a SINGLE STRING with steps separated by newline characters (\\n). Example: "Step 1\\nStep 2\\nStep 3"'
            }
        };
        
        return this.getMergedSchema(toolSchema);
    }
    
    getResultSchema(): JSONSchema {
        return {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                data: {
                    type: 'object',
                    properties: {
                        workspaceId: { type: 'string' },
                        workspace: { type: 'object' },
                        validationPrompt: { type: 'string' }
                    }
                }
            }
        };
    }
}