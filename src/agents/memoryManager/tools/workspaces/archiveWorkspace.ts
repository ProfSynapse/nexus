/**
 * Location: /src/agents/memoryManager/tools/workspaces/ArchiveWorkspace.ts
 * Purpose: Archive a workspace (soft delete) by setting isArchived flag
 *
 * Used by: MemoryManager agent for workspace archival operations
 */

import { App } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { MemoryManagerAgent } from '../../memoryManager';
import { createServiceIntegration } from '../../services/ValidationService';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { CommonResult, CommonParameters } from '../../../../types/mcp/AgentTypes';

// Define parameter and result types for workspace archival
export interface ArchiveWorkspaceParameters extends CommonParameters {
    name: string;  // Workspace name to archive/restore
    restore?: boolean;  // If true, restores from archive instead of archiving
}

export interface ArchiveWorkspaceResult extends CommonResult {
    success: boolean;
    error?: string;
}

/**
 * ArchiveWorkspace - Soft delete a workspace by setting isArchived flag
 */
export class ArchiveWorkspaceTool extends BaseTool<ArchiveWorkspaceParameters, ArchiveWorkspaceResult> {
    private app: App;
    private serviceIntegration: ReturnType<typeof createServiceIntegration>;

    constructor(private agent: MemoryManagerAgent) {
        super(
            'archiveWorkspace',
            'Archive Workspace',
            'Archive a workspace (soft delete). Workspace will be hidden from lists but can be restored.',
            '1.0.0'
        );

        this.app = agent.getApp();
        this.serviceIntegration = createServiceIntegration(this.app, {
            logLevel: 'warn',
            maxRetries: 2,
            fallbackBehavior: 'warn'
        });
    }

    async execute(params: ArchiveWorkspaceParameters): Promise<ArchiveWorkspaceResult> {
        try {
            // Get workspace service
            const serviceResult = await this.serviceIntegration.getWorkspaceService();
            if (!serviceResult.success || !serviceResult.service) {
                return this.prepareResult(false, undefined, `Workspace service not available: ${serviceResult.error}`);
            }

            const workspaceService = serviceResult.service;

            // Validate workspace exists
            const existingWorkspace = await workspaceService.getWorkspaceByNameOrId(params.name);
            if (!existingWorkspace) {
                return this.prepareResult(false, undefined, `Workspace "${params.name}" not found. Use listWorkspaces to see available workspaces.`);
            }

            const isRestore = params.restore === true;

            // Check current state
            if (isRestore && !existingWorkspace.isArchived) {
                return this.prepareResult(false, undefined, `Workspace "${params.name}" is not archived.`);
            }
            if (!isRestore && existingWorkspace.isArchived) {
                return this.prepareResult(false, undefined, `Workspace "${params.name}" is already archived.`);
            }

            // Create a copy and toggle isArchived flag
            const workspaceCopy = JSON.parse(JSON.stringify(existingWorkspace));
            workspaceCopy.isArchived = !isRestore;
            workspaceCopy.lastAccessed = Date.now();

            // Perform the update
            await workspaceService.updateWorkspace(existingWorkspace.id, workspaceCopy);

            // Success - LLM already knows what it passed
            return this.prepareResult(true);

        } catch (error) {
            return this.prepareResult(false, undefined, createErrorMessage('Error archiving workspace: ', error));
        }
    }

    getParameterSchema(): Record<string, unknown> {
        const toolSchema = {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Name of the workspace to archive or restore (REQUIRED)'
                },
                restore: {
                    type: 'boolean',
                    description: 'If true, restores the workspace from archive. If false/omitted, archives the workspace.'
                }
            },
            required: ['name']
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
