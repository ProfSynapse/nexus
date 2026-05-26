/**
 * Location: src/agents/memoryManager/tools/states/archiveState.ts
 * Purpose: Archive a state (soft delete) by toggling the isArchived flag in
 * its WorkspaceState.state.metadata. Mirrors archiveWorkspace.
 *
 * Used by: MemoryManager agent for state archival operations.
 */

import { BaseTool } from '../../../baseTool';
import { MemoryManagerAgent } from '../../memoryManager';
import { labelNamed, verbs } from '../../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { CommonResult, CommonParameters } from '../../../../types/mcp/AgentTypes';
import { GLOBAL_WORKSPACE_ID } from '../../../../services/WorkspaceService';
import type { WorkspaceState } from '../../../../database/types/session/SessionTypes';

interface StateListItem {
    id: string;
    name: string;
    sessionId?: string;
    state?: WorkspaceState;
}

export interface ArchiveStateParameters extends CommonParameters {
    name: string;
    restore?: boolean;
}

export interface ArchiveStateResult extends CommonResult {
    success: boolean;
    error?: string;
}

/**
 * ArchiveStateTool - Soft delete a state by setting metadata.isArchived flag.
 */
export class ArchiveStateTool extends BaseTool<ArchiveStateParameters, ArchiveStateResult> {
    constructor(private agent: MemoryManagerAgent) {
        super(
            'archiveState',
            'Archive State',
            'Archive a state (soft delete). State will be hidden from lists but can be restored.',
            '1.0.0'
        );
    }

    async execute(params: ArchiveStateParameters): Promise<ArchiveStateResult> {
        try {
            const memoryService = await this.agent.getMemoryServiceAsync();
            if (!memoryService) {
                return this.prepareResult(false, undefined, 'Memory service not available');
            }
            const workspaceService = await this.agent.getWorkspaceServiceAsync();
            if (!workspaceService) {
                return this.prepareResult(false, undefined, 'Workspace service not available');
            }

            const inheritedContext = this.getInheritedWorkspaceContext(params);
            const workspaceIdentifier = inheritedContext?.workspaceId || GLOBAL_WORKSPACE_ID;
            const workspace = await workspaceService.getWorkspaceByNameOrId(workspaceIdentifier);
            if (!workspace) {
                return this.prepareResult(false, undefined, `Workspace not found: ${workspaceIdentifier}`);
            }

            const statesResult = await memoryService.getStates(workspace.id);
            const match = (statesResult.items as unknown as StateListItem[]).find(
                (s) => s.id === params.name || s.name === params.name
            );
            if (!match) {
                return this.prepareResult(false, undefined, `State "${params.name}" not found. Use listStates to see available states.`);
            }

            const existingState = match.state;
            if (!existingState) {
                return this.prepareResult(false, undefined, `State "${params.name}" data is missing.`);
            }

            const isRestore = params.restore === true;
            const currentArchived = existingState.state?.metadata?.isArchived === true;

            if (isRestore && !currentArchived) {
                return this.prepareResult(false, undefined, `State "${params.name}" is not archived.`);
            }
            if (!isRestore && currentArchived) {
                return this.prepareResult(false, undefined, `State "${params.name}" is already archived.`);
            }

            const sessionId = match.sessionId || existingState.sessionId;
            if (!sessionId) {
                return this.prepareResult(false, undefined, `State "${params.name}" has no session ID; cannot update.`);
            }

            const nextState: WorkspaceState = {
                ...existingState,
                state: {
                    workspace: existingState.state?.workspace ?? null,
                    recentTraces: existingState.state?.recentTraces ?? [],
                    contextFiles: existingState.state?.contextFiles ?? [],
                    metadata: {
                        ...(existingState.state?.metadata ?? {}),
                        isArchived: !isRestore
                    }
                }
            };

            await memoryService.updateState(workspace.id, sessionId, match.id, { state: nextState });

            return this.prepareResult(true);
        } catch (error) {
            return this.prepareResult(false, undefined, createErrorMessage('Error archiving state: ', error));
        }
    }

    getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
        const isRestore = params?.restore === true;
        const v = isRestore
            ? verbs('Restoring state', 'Restored state', 'Failed to restore state')
            : verbs('Archiving state', 'Archived state', 'Failed to archive state');
        return labelNamed(v, params, tense, ['name']);
    }

    getParameterSchema(): Record<string, unknown> {
        const toolSchema = {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Name or ID of the state to archive or restore (REQUIRED).'
                },
                restore: {
                    type: 'boolean',
                    description: 'If true, restores the state from archive. If false/omitted, archives the state.'
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
