/**
 * Location: /src/agents/memoryManager/tools/states/ArchiveState.ts
 * Purpose: Archive a state (soft delete) by setting isArchived flag
 *
 * Used by: MemoryManager agent for state archival operations
 */

import { App } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { MemoryManagerAgent } from '../../memoryManager'
import { ArchiveStateParams, StateResult } from '../../types';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { extractContextFromParams } from '../../../../utils/contextUtils';
import { MemoryService } from "../../services/MemoryService";
import { WorkspaceService, GLOBAL_WORKSPACE_ID } from '../../../../services/WorkspaceService';
import { createServiceIntegration } from '../../services/ValidationService';

/**
 * Archive State Tool - Sets isArchived flag on a state (soft delete)
 */
export class ArchiveStateTool extends BaseTool<ArchiveStateParams, StateResult> {
    private app: App;
    private serviceIntegration: ReturnType<typeof createServiceIntegration>;

    constructor(private agent: MemoryManagerAgent) {
        super(
            'archiveState',
            'Archive State',
            'Archive a state (soft delete). Archived states are hidden from lists but preserved.',
            '1.0.0'
        );

        this.app = agent.getApp();
        this.serviceIntegration = createServiceIntegration(this.app, {
            logLevel: 'warn',
            maxRetries: 2,
            fallbackBehavior: 'warn'
        });
    }

    async execute(params: ArchiveStateParams): Promise<StateResult> {
        try {
            // Get services
            const servicesResult = await this.getServices();
            if (!servicesResult.success) {
                return this.prepareResult(false, undefined, servicesResult.error);
            }

            const { memoryService } = servicesResult;
            if (!memoryService) {
                return this.prepareResult(false, undefined, 'Memory service not available');
            }

            // Extract workspaceId from params (use '_workspace' as sessionId)
            const parsedContext = params.workspaceContext ?
                (typeof params.workspaceContext === 'string' ? JSON.parse(params.workspaceContext) : params.workspaceContext) : null;
            const workspaceId = parsedContext?.workspaceId || GLOBAL_WORKSPACE_ID;

            // Get existing state using unified lookup (ID or name)
            const existingState = await memoryService.getStateByNameOrId(workspaceId, '_workspace', params.name);
            if (!existingState) {
                return this.prepareResult(
                    false,
                    undefined,
                    `State "${params.name}" not found. Use listStates to see available states.`,
                    extractContextFromParams(params)
                );
            }

            const isRestore = params.restore === true;
            const actualStateId = existingState.id || params.name;

            // Check current archived status
            const currentlyArchived = existingState.state?.metadata?.isArchived === true;
            if (isRestore && !currentlyArchived) {
                return this.prepareResult(
                    false,
                    undefined,
                    `State "${params.name}" is not archived.`,
                    extractContextFromParams(params)
                );
            }
            if (!isRestore && currentlyArchived) {
                return this.prepareResult(
                    false,
                    undefined,
                    `State "${params.name}" is already archived.`,
                    extractContextFromParams(params)
                );
            }

            // Create a copy of the state and toggle the isArchived flag
            const updatedState: any = { ...existingState };
            if (!updatedState.state) {
                updatedState.state = { workspace: null, recentTraces: [], contextFiles: [], metadata: {} };
            }
            if (!updatedState.state.metadata) {
                updatedState.state.metadata = {};
            }
            updatedState.state.metadata.isArchived = !isRestore;

            // Update the state
            await memoryService.updateState(workspaceId, '_workspace', actualStateId, {
                name: updatedState.name,
                state: updatedState.state
            });

            // Verify update succeeded
            const verifiedState = await memoryService.getState(workspaceId, '_workspace', actualStateId);
            const expectedArchived = !isRestore;
            if (!verifiedState || verifiedState.state?.metadata?.isArchived !== expectedArchived) {
                return this.prepareResult(
                    false,
                    undefined,
                    isRestore ? 'Failed to restore state' : 'Failed to archive state',
                    extractContextFromParams(params)
                );
            }

            // Success - LLM already knows what it passed
            return this.prepareResult(true);

        } catch (error) {
            const errorMsg = createErrorMessage('Error archiving state: ', error);
            return this.prepareResult(
                false,
                undefined,
                errorMsg,
                extractContextFromParams(params)
            );
        }
    }

    private async getServices(): Promise<{success: boolean; error?: string; memoryService?: MemoryService; workspaceService?: WorkspaceService}> {
        const [memoryResult, workspaceResult] = await Promise.all([
            this.serviceIntegration.getMemoryService(),
            this.serviceIntegration.getWorkspaceService()
        ]);

        if (!memoryResult.success || !memoryResult.service) {
            return { success: false, error: `Memory service not available: ${memoryResult.error}` };
        }

        if (!workspaceResult.success || !workspaceResult.service) {
            return { success: false, error: `Workspace service not available: ${workspaceResult.error}` };
        }

        return {
            success: true,
            memoryService: memoryResult.service,
            workspaceService: workspaceResult.service
        };
    }

    getParameterSchema(): any {
        const customSchema = {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Name of the state to archive or restore (REQUIRED). Use listStates({ includeArchived: true }) to see all states.'
                },
                restore: {
                    type: 'boolean',
                    description: 'If true, restores the state from archive. If false/omitted, archives the state.'
                }
            },
            required: ['name'],
            additionalProperties: false
        };

        return this.getMergedSchema(customSchema);
    }

    getResultSchema(): any {
        return {
            type: 'object',
            properties: {
                success: {
                    type: 'boolean',
                    description: 'Whether the operation was successful'
                },
                error: {
                    type: 'string',
                    description: 'Error message if operation failed'
                }
            },
            required: ['success'],
            additionalProperties: false
        };
    }
}
