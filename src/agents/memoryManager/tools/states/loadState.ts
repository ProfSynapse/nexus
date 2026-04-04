import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
/**
 * Location: /src/agents/memoryManager/modes/states/LoadStateMode.ts
 * Purpose: Consolidated state loading mode combining all load functionality from original state files
 * 
 * This file consolidates:
 * - Original loadStateMode.ts functionality
 * - StateRetriever and restoration logic
 * - FileCollector and TraceProcessor logic
 * - SessionManager and WorkspaceContextBuilder logic
 * - RestorationSummaryGenerator and RestorationTracer logic
 * 
 * Used by: MemoryManager agent for state loading and restoration operations
 */

import { App } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { MemoryManagerAgent } from '../../memoryManager'
import { LoadStateParams, StateResult } from '../../types';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { extractContextFromParams } from '../../../../utils/contextUtils';
import { MemoryService } from "../../services/MemoryService";
import { WorkspaceService, GLOBAL_WORKSPACE_ID } from '../../../../services/WorkspaceService';
import { createServiceIntegration } from '../../services/ValidationService';
import { SchemaBuilder, SchemaType } from '../../../../utils/schemas/SchemaBuilder';
import { WorkspaceMemoryTrace, WorkspaceState } from '../../../../database/types';
import { IndividualWorkspace } from '../../../../types/storage/StorageTypes';

type WorkspaceContextInput = {
    workspaceId?: string;
    [key: string]: unknown;
};

interface LoadedStateContext {
    conversationContext?: string;
    activeTask?: string;
    activeFiles?: string[];
    nextSteps?: string[];
    workspaceContext?: unknown;
}

interface LoadedStateResult {
    loadedState: WorkspaceState;
    relatedTraces: WorkspaceMemoryTrace[];
}

interface RestoredStateResult {
    summary: string;
    associatedNotes: string[];
    stateCreatedAt: string;
    originalSessionId?: string;
    workspace: Pick<IndividualWorkspace, 'name'> | null;
    restoredContext: {
        conversationContext?: string;
        activeTask?: string;
        activeFiles: string[];
        nextSteps: string[];
        reasoning?: string;
        workspaceContext?: unknown;
    };
    traces: Array<{
        timestamp: number;
        content: string;
        type: string;
        importance?: number;
    }>;
}

/**
 * Consolidated LoadStateMode - combines all state loading functionality
 */
export class LoadStateTool extends BaseTool<LoadStateParams, StateResult> {
    private app: App;
    private serviceIntegration: ReturnType<typeof createServiceIntegration>;
    private schemaBuilder: SchemaBuilder;

    constructor(private agent: MemoryManagerAgent) {
        super(
            'loadState',
            'Load State',
            'Load a saved state and optionally create a continuation session with restored context',
            '2.0.0'
        );

        this.app = agent.getApp();
        this.serviceIntegration = createServiceIntegration(this.app, {
            logLevel: 'warn',
            maxRetries: 2,
            fallbackBehavior: 'warn'
        });
        this.schemaBuilder = new SchemaBuilder();
    }

    /**
     * Execute state loading with consolidated logic
     */
    async execute(params: LoadStateParams): Promise<StateResult> {
        try {
            // Phase 1: Get services and validate
            const servicesResult = await this.getServices();
            if (!servicesResult.success) {
                return this.prepareResult(false, undefined, servicesResult.error);
            }

            const { memoryService, workspaceService } = servicesResult;

            // Phase 2: Extract workspaceId and load state data
            if (!memoryService) {
                return this.prepareResult(false, undefined, 'Memory service not available', extractContextFromParams(params));
            }

            // Extract workspaceId from params (use '_workspace' as sessionId for workspace-scoped states)
            const parsedContext = parseWorkspaceContext(params.workspaceContext);
            const workspaceId = parsedContext?.workspaceId || GLOBAL_WORKSPACE_ID;

            // Use name (required) or fall back to deprecated stateId for backward compatibility
            const stateName = params.name ?? getLegacyStateId(params);
            if (!stateName) {
                return this.prepareResult(false, undefined, 'State name is required. Use listStates to see available states.', extractContextFromParams(params));
            }
            const stateResult = await this.loadStateData(workspaceId, '_workspace', stateName, memoryService);
            if (!stateResult.success) {
                return this.prepareResult(false, undefined, stateResult.error, extractContextFromParams(params));
            }
            if (!stateResult.data) {
                return this.prepareResult(false, undefined, 'State loading failed - no state data returned', extractContextFromParams(params));
            }

            // Phase 3: Process and restore context (consolidated from FileCollector and TraceProcessor logic)
            if (!workspaceService) {
                return this.prepareResult(false, undefined, 'Workspace service not available', extractContextFromParams(params));
            }
            const contextResult = await this.processAndRestoreContext(stateResult.data, workspaceService, memoryService);

            // Phase 4: Prepare simplified result (no session continuation, just return state data)
            return this.prepareFinalResult(
                stateResult.data,
                contextResult
            );

        } catch (error) {
            return this.prepareResult(false, undefined, createErrorMessage('Error loading state: ', error));
        }
    }

    /**
     * Get required services with validation
     */
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

    /**
     * Load state data (consolidated from StateRetriever logic)
     * Looks up state by name
     */
    private async loadStateData(workspaceId: string, sessionId: string, stateName: string, memoryService: MemoryService): Promise<{success: boolean; error?: string; data?: LoadedStateResult}> {
        try {
            // Get state from memory service by name
            const loadedState = await memoryService.getStateByNameOrId(workspaceId, sessionId, stateName);
            if (!loadedState) {
                return { success: false, error: `State "${stateName}" not found. Use listStates to see available states.` };
            }

            // Get related traces if available using the actual state's session ID
            let relatedTraces: WorkspaceMemoryTrace[] = [];
            try {
                const effectiveSessionId = loadedState.sessionId || sessionId;
                if (effectiveSessionId && effectiveSessionId !== 'current') {
                    const tracesResult = await memoryService.getMemoryTraces(workspaceId, effectiveSessionId);
                    relatedTraces = tracesResult.items;
                }
            } catch {
                // Ignore errors getting traces - not critical for state loading
            }

            return {
                success: true,
                data: {
                    loadedState,
                    relatedTraces: relatedTraces || []
                }
            };

        } catch (error) {
            return { success: false, error: createErrorMessage('Error loading state data: ', error) };
        }
    }

    /**
     * Process and restore context (consolidated from FileCollector and TraceProcessor logic)
     */
    private async processAndRestoreContext(stateData: LoadedStateResult, workspaceService: WorkspaceService, _memoryService: MemoryService): Promise<RestoredStateResult> {
        try {
            const { loadedState, relatedTraces } = stateData;

            // Get workspace for context
            let workspace: Pick<IndividualWorkspace, 'name'> | null;
            try {
                workspace = await workspaceService.getWorkspace(loadedState.workspaceId);
            } catch {
                workspace = { name: 'Unknown Workspace' };
            }

            // Extract state context details (using new naming: context instead of snapshot)
            const stateContext = loadedState.context || {};

            // Build context summary (consolidated from FileCollector logic)
            const summary = this.buildContextSummary(loadedState, workspace, stateContext);

            // Process active files (consolidated file collection logic)
            const activeFiles = stateContext.activeFiles || [];
            const associatedNotes = this.processActiveFiles(activeFiles);

            // Process memory traces (consolidated from TraceProcessor logic)
            const processedTraces = this.processMemoryTraces(relatedTraces);

        return {
            summary,
            associatedNotes,
            stateCreatedAt: new Date(loadedState.created).toISOString(),
            originalSessionId: loadedState.sessionId,
            workspace,
            restoredContext: {
                conversationContext: stateContext.conversationContext,
                activeTask: stateContext.activeTask,
                activeFiles,
                nextSteps: stateContext.nextSteps || [],
                workspaceContext: stateContext.workspaceContext
            },
            traces: processedTraces
        };

        } catch {
            return {
                summary: `State "${stateData.loadedState.name}" loaded successfully`,
                associatedNotes: [],
                stateCreatedAt: new Date().toISOString(),
                originalSessionId: stateData.loadedState.sessionId,
                workspace: { name: 'Unknown Workspace' },
                restoredContext: {
                    conversationContext: 'Context restoration incomplete',
                    activeTask: 'Resume from saved state',
                    activeFiles: [],
                    nextSteps: [],
                },
                traces: []
            };
        }
    }

    /**
     * Prepare final result - simplified to return just the structured state data
     */
    private prepareFinalResult(stateData: LoadedStateResult, _contextResult: RestoredStateResult): StateResult {
        const loadedState = stateData.loadedState;
        const stateContext: LoadedStateContext = loadedState.context || {};

        const resultData = {
            name: loadedState.name,
            conversationContext: stateContext.conversationContext,
            activeTask: stateContext.activeTask,
            activeFiles: stateContext.activeFiles || [],
            nextSteps: stateContext.nextSteps || [],
            description: loadedState.description,
            tags: loadedState.state?.metadata?.tags || []
        };

        return this.prepareResult(
            true,
            resultData,
            undefined,
            undefined
        );
    }

    /**
     * Helper methods (consolidated from various services)
     */
    private buildContextSummary(loadedState: WorkspaceState, workspace: Pick<IndividualWorkspace, 'name'> | null, stateContext: LoadedStateContext): string {
        const parts: string[] = [];

        parts.push(`Loaded state: "${loadedState.name}"`);
        parts.push(`Workspace: ${workspace?.name ?? 'Unknown Workspace'}`);

        if (stateContext.activeTask) {
            parts.push(`Active task: ${stateContext.activeTask}`);
        }

        if (stateContext.conversationContext) {
            const contextPreview = stateContext.conversationContext.length > 100
                ? stateContext.conversationContext.substring(0, 100) + '...'
                : stateContext.conversationContext;
            parts.push(`Context: ${contextPreview}`);
        }

        if (stateContext.activeFiles && stateContext.activeFiles.length > 0) {
            parts.push(`${stateContext.activeFiles.length} active file${stateContext.activeFiles.length === 1 ? '' : 's'}`);
        }

        if (stateContext.nextSteps && stateContext.nextSteps.length > 0) {
            parts.push(`${stateContext.nextSteps.length} next step${stateContext.nextSteps.length === 1 ? '' : 's'} defined`);
        }

        const stateAge = Date.now() - loadedState.created;
        const daysAgo = Math.floor(stateAge / (1000 * 60 * 60 * 24));
        if (daysAgo > 0) {
            parts.push(`Created ${daysAgo} day${daysAgo === 1 ? '' : 's'} ago`);
        } else {
            const hoursAgo = Math.floor(stateAge / (1000 * 60 * 60));
            if (hoursAgo > 0) {
                parts.push(`Created ${hoursAgo} hour${hoursAgo === 1 ? '' : 's'} ago`);
            } else {
                parts.push('Created recently');
            }
        }

        return parts.join('. ');
    }

    private processActiveFiles(activeFiles: string[]): string[] {
        // Filter and validate active files
        return activeFiles
            .filter(file => file && typeof file === 'string')
            .slice(0, 20); // Limit to 20 files for performance
    }

    private processMemoryTraces(traces: WorkspaceMemoryTrace[]): RestoredStateResult['traces'] {
        // Process and format traces for display
        return traces
            .slice(0, 5) // Limit to 5 most recent traces
            .map(trace => ({
                timestamp: trace.timestamp,
                content: trace.content.substring(0, 150) + (trace.content.length > 150 ? '...' : ''),
                type: trace.type,
                importance: (trace.metadata as { importance?: number } | undefined)?.importance
            }));
    }

    /**
     * Schema methods using consolidated logic
     */
    getParameterSchema(): JSONSchema {
        const toolSchema = {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Name of the state to load (REQUIRED). Use listStates to see available states.'
                }
            },
            required: ['name'],
            additionalProperties: false
        };

        return this.getMergedSchema(toolSchema);
    }

    getResultSchema(): JSONSchema {
        return this.schemaBuilder.buildResultSchema(SchemaType.State, {
            mode: 'loadState'
        });
    }
}

function parseWorkspaceContext(value: unknown): WorkspaceContextInput | null {
    if (!value) {
        return null;
    }

    if (typeof value === 'string') {
        try {
            const parsed: unknown = JSON.parse(value);
            return isWorkspaceContextInput(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    return isWorkspaceContextInput(value) ? value : null;
}

function isWorkspaceContextInput(value: unknown): value is WorkspaceContextInput {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getLegacyStateId(params: LoadStateParams): string | undefined {
    const legacyParams = params as unknown as Record<string, unknown>;
    const stateId = legacyParams['stateId'];
    return typeof stateId === 'string' ? stateId : undefined;
}
