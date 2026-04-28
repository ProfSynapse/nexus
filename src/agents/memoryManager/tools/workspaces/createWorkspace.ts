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
import { MemoryManagerAgent } from '../../memoryManager';
import { labelNamed, verbs } from '../../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { createServiceIntegration } from '../../services/ValidationService';
import type { IndividualWorkspace } from '../../../../types/storage/StorageTypes';
import { addRecommendations, Recommendation } from '../../../../utils/recommendationUtils';
import { NudgeHelpers } from '../../../../utils/nudgeHelpers';

// Import types from existing workspace mode
import { 
    CreateWorkspaceParameters, 
    CreateWorkspaceResult
} from '../../../../database/types/workspace/ParameterTypes';
import { WorkspaceContext } from '../../../../database/types/workspace/WorkspaceTypes';
import { createErrorMessage } from '../../../../utils/errorUtils';

type CreateWorkspaceResultWithRecommendations = CreateWorkspaceResult & {
    recommendations: Recommendation[];
};

interface WorkspaceServiceLike {
    getWorkspaceByNameOrId(identifier: string): Promise<IndividualWorkspace | null>;
    createWorkspace(workspace: Partial<IndividualWorkspace>): Promise<IndividualWorkspace>;
}

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
            'Create a new workspace with structured context data. Follow-up workspace tools accept the workspace name.',
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
            
            const workspaceService = serviceResult.service as WorkspaceServiceLike;
            
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
            } catch {
                // Ignore folder creation errors
            }
            
            // Combine provided key files with auto-detected ones
            const providedKeyFiles = params.keyFiles || [];
            const autoDetectedKeyFiles = this.detectSimpleKeyFiles(params.rootFolder);
            const allKeyFiles = [...new Set([...providedKeyFiles, ...autoDetectedKeyFiles])]; // Remove duplicates

            // Build workspace context (don't include dedicatedAgent object yet - will be resolved on load)
            const context: WorkspaceContext = {
                purpose: params.purpose,
                workflows: params.workflows,
                keyFiles: allKeyFiles,
                preferences: params.preferences || ''
            };

            // Create workspace data
            const now = Date.now();
            const workspaceData: Partial<IndividualWorkspace> & Record<string, unknown> = {
                name: params.name,
                context: context,
                rootFolder: params.rootFolder,
                created: now,
                lastAccessed: now,
                description: params.description,
                dedicatedAgentId: params.dedicatedAgentId, // Store ID or name as-is
                sessions: {},
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
            } catch {
                // Ignore lookup errors
            }

            // Save workspace
            const workspace = await workspaceService.createWorkspace(workspaceData);

            const result = this.prepareResult(true);
            return addRecommendations(result, [
                NudgeHelpers.suggestWorkspaceNameFollowup(workspace.name)
            ]) as CreateWorkspaceResultWithRecommendations;

        } catch (error) {
            return this.prepareResult(false, undefined, createErrorMessage('Error creating workspace: ', error));
        }
    }
    
    /**
     * Auto-detect key files in workspace folder (simple array format)
     */
    private detectSimpleKeyFiles(rootFolder: string): string[] {
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
                        } catch {
                            // Ignore frontmatter parsing errors
                        }
                    }
                }
            }

            return detectedFiles;

        } catch {
            return [];
        }
    }

    getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
        return labelNamed(verbs('Creating workspace', 'Created workspace', 'Failed to create workspace'), params, tense, ['name']);
    }

    getParameterSchema(): JSONSchema {
        const toolSchema = {
            type: 'object',
            title: 'Create Workspace',
            description: 'Create a new workspace with structured workflows and context. Follow-up workspace commands accept the workspace name; do not list workspaces solely to recover a UUID.',
            properties: {
                name: {
                    type: 'string',
                    description: 'Workspace name. This name can be used directly in follow-up workspace commands such as load-workspace and update-workspace; the UUID is not required unless you prefer it.'
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
                    description: 'Workflows for different situations. Each workflow may also bind a prompt and schedule.',
                    items: {
                        type: 'object',
                        properties: {
                            id: {
                                type: 'string',
                                description: 'Optional stable workflow ID. If omitted, one will be generated.'
                            },
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
                            },
                            promptId: {
                                type: 'string',
                                description: 'Optional custom prompt ID bound to this workflow.'
                            },
                            promptName: {
                                type: 'string',
                                description: 'Optional cached prompt name for display.'
                            },
                            schedule: {
                                type: 'object',
                                description: 'Optional workflow schedule.',
                                properties: {
                                    enabled: { type: 'boolean' },
                                    frequency: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'monthly'] },
                                    intervalHours: { type: 'number' },
                                    hour: { type: 'number' },
                                    minute: { type: 'number' },
                                    dayOfWeek: { type: 'number' },
                                    dayOfMonth: { type: 'number' },
                                    catchUp: { type: 'string', enum: ['skip', 'latest', 'all'] }
                                },
                                required: ['enabled', 'frequency', 'catchUp']
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
                },
                recommendations: {
                    type: 'array',
                    description: 'Agent-facing nudges and recommendations.',
                    items: {
                        type: 'object',
                        properties: {
                            type: { type: 'string' },
                            message: { type: 'string' }
                        },
                        required: ['type', 'message']
                    }
                }
            }
        };
    }
}
