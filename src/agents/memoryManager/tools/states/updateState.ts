/**
 * Location: src/agents/memoryManager/tools/states/updateState.ts
 * Purpose: Update mutable metadata on an existing state (name, description,
 * tags). The inner snapshot context (conversationContext, activeTask,
 * activeFiles, nextSteps) is intentionally immutable — states are snapshots.
 *
 * Used by: MemoryManager agent for state metadata updates.
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

export interface UpdateStateParameters extends CommonParameters {
    name: string;
    newName?: string;
    description?: string;
    tags?: string[];
}

export interface UpdateStateResult extends CommonResult {
    success: boolean;
    error?: string;
}

/**
 * UpdateStateTool - Modify state metadata (name, description, tags).
 * The inner snapshot context remains frozen.
 */
export class UpdateStateTool extends BaseTool<UpdateStateParameters, UpdateStateResult> {
    constructor(private agent: MemoryManagerAgent) {
        super(
            'updateState',
            'Update State',
            'Update state metadata (name, description, tags). Snapshot context is immutable.',
            '1.0.0'
        );
    }

    async execute(params: UpdateStateParameters): Promise<UpdateStateResult> {
        try {
            const memoryService = await this.agent.getMemoryServiceAsync();
            if (!memoryService) {
                return this.prepareResult(false, undefined, 'Memory service not available');
            }
            const workspaceService = await this.agent.getWorkspaceServiceAsync();
            if (!workspaceService) {
                return this.prepareResult(false, undefined, 'Workspace service not available');
            }

            if (
                params.newName === undefined &&
                params.description === undefined &&
                params.tags === undefined
            ) {
                return this.prepareResult(
                    false,
                    undefined,
                    'No updates provided. Pass at least one of: newName, description, tags.'
                );
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

            const sessionId = match.sessionId || match.state?.sessionId;
            if (!sessionId) {
                return this.prepareResult(false, undefined, `State "${params.name}" has no session ID; cannot update.`);
            }

            if (params.newName !== undefined && params.newName !== match.name) {
                const conflict = (statesResult.items as unknown as StateListItem[]).find(
                    (s) => s.id !== match.id && s.name === params.newName
                );
                if (conflict) {
                    return this.prepareResult(false, undefined, `State name "${params.newName}" is already in use.`);
                }
            }

            const updates: Partial<{ name: string; description: string; tags: string[] }> = {};
            if (params.newName !== undefined) updates.name = params.newName;
            if (params.description !== undefined) updates.description = params.description;
            if (params.tags !== undefined) updates.tags = params.tags;

            await memoryService.updateState(workspace.id, sessionId, match.id, updates);

            return this.prepareResult(true);
        } catch (error) {
            return this.prepareResult(false, undefined, createErrorMessage('Error updating state: ', error));
        }
    }

    getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
        return labelNamed(verbs('Updating state', 'Updated state', 'Failed to update state'), params, tense, ['name']);
    }

    getParameterSchema(): Record<string, unknown> {
        const toolSchema = {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Name or ID of the state to update (REQUIRED). This selects the target state.'
                },
                newName: {
                    type: 'string',
                    description: 'New name for the state (optional). This renames the state; it is not the target identifier.'
                },
                description: {
                    type: 'string',
                    description: 'New description for the state (optional).'
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'New tags array for the state (optional, replaces the prior tag list).'
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
