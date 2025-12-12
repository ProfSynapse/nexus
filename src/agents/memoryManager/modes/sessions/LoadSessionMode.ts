/**
 * Location: /src/agents/memoryManager/modes/sessions/LoadSessionMode.ts
 * Purpose: Consolidated session loading mode combining all load functionality from original session files
 * 
 * This file consolidates:
 * - Original loadSessionMode.ts functionality
 * - LoadStateMode restoration logic
 * - SessionManager restoration logic
 * - WorkspaceContextBuilder logic
 * - RestorationTracer and RestorationSummaryGenerator logic
 * 
 * Used by: MemoryManager agent for session loading and continuation operations
 */

import { App } from 'obsidian';
import { BaseMode } from '../../../baseMode';
import { MemoryManagerAgent } from '../../memoryManager'
import { LoadSessionParams, SessionResult } from '../../types';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { extractContextFromParams } from '../../../../utils/contextUtils';
import { MemoryService } from "../../services/MemoryService";
import { WorkspaceService } from '../../../../services/WorkspaceService';
import { createServiceIntegration } from '../../services/ValidationService';
import { SchemaBuilder, SchemaType } from '../../../../utils/schemas/SchemaBuilder';

/**
 * Consolidated LoadSessionMode - combines all session loading functionality
 */
export class LoadSessionMode extends BaseMode<LoadSessionParams, SessionResult> {
    private app: App;
    private serviceIntegration: ReturnType<typeof createServiceIntegration>;
    private schemaBuilder: SchemaBuilder;

    constructor(private agent: MemoryManagerAgent) {
        super(
            'loadSession',
            'Load Session',
            'Load an existing session and optionally create a continuation session',
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
     * Execute session loading with consolidated logic
     */
    async execute(params: LoadSessionParams): Promise<SessionResult> {
        try {
            // Phase 1: Get services and validate
            const servicesResult = await this.getServices();
            if (!servicesResult.success) {
                return this.prepareResult(false, undefined, servicesResult.error);
            }

            const { memoryService, workspaceService } = servicesResult;
            
            // Type assertions - services are guaranteed to be defined when success is true
            if (!memoryService || !workspaceService) {
                return this.prepareResult(false, undefined, 'Services not available after successful retrieval');
            }

            // Phase 2: Get target session ID and workspaceId (consolidated from parameter handling)
            // targetSessionId is explicit param, fallback to context.sessionId (single source of truth)
            const targetSessionId = params.targetSessionId || params.context?.sessionId;
            if (!targetSessionId) {
                return this.prepareResult(false, undefined, 'No session ID provided to load');
            }

            // Extract workspaceId from params
            const parsedContext = params.workspaceContext ?
                (typeof params.workspaceContext === 'string' ? JSON.parse(params.workspaceContext) : params.workspaceContext) : null;
            const workspaceId = parsedContext?.workspaceId || 'default-workspace';

            // Phase 3: Load session data (consolidated from StateRetriever logic)
            const sessionResult = await this.loadSessionData(workspaceId, targetSessionId, memoryService);
            if (!sessionResult.success) {
                return this.prepareResult(false, undefined, sessionResult.error, extractContextFromParams(params));
            }

            // Phase 4: Build session context (consolidated from WorkspaceContextBuilder logic)
            const contextResult = await this.buildSessionContext(sessionResult.data, workspaceService, memoryService);

            // Phase 5: Create continuation session if requested (consolidated from SessionManager logic)
            let continuationSessionId: string | undefined;
            if (params.createContinuationSession !== false) {
                const continuationResult = await this.createContinuationSession(
                    params,
                    sessionResult.data,
                    contextResult,
                    memoryService
                );
                if (continuationResult.success) {
                    continuationSessionId = continuationResult.sessionId;
                }
            }

            // Phase 6: Generate restoration summary (consolidated from RestorationSummaryGenerator logic)
            const summaryResult = this.generateRestorationSummary(
                sessionResult.data,
                contextResult,
                continuationSessionId
            );

            // Phase 7: Create restoration trace (consolidated from RestorationTracer logic)
            if (continuationSessionId) {
                await this.createRestorationTrace(
                    sessionResult.data,
                    contextResult,
                    continuationSessionId,
                    memoryService
                );
            }

            // Phase 8: Prepare final result
            return this.prepareFinalResult(
                sessionResult.data,
                contextResult,
                summaryResult,
                continuationSessionId
            );

        } catch (error) {
            return this.prepareResult(false, undefined, createErrorMessage('Error loading session: ', error));
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
     * Load session data (consolidated from StateRetriever logic)
     * Supports lookup by both session ID and session name
     */
    private async loadSessionData(workspaceId: string, sessionIdentifier: string, memoryService: MemoryService): Promise<{success: boolean; error?: string; data?: any}> {
        try {
            // Get session from memory service using unified lookup (ID or name)
            const session = await memoryService.getSessionByNameOrId(workspaceId, sessionIdentifier);
            if (!session) {
                return { success: false, error: `Session '${sessionIdentifier}' not found (searched by both name and ID)` };
            }

            // Get session traces for context using the actual session ID
            const traces = await memoryService.getMemoryTraces(workspaceId, session.id);

            return {
                success: true,
                data: {
                    session,
                    traces: traces || []
                }
            };

        } catch (error) {
            return { success: false, error: createErrorMessage('Error loading session data: ', error) };
        }
    }

    /**
     * Build session context (consolidated from WorkspaceContextBuilder logic)
     */
    private async buildSessionContext(sessionData: any, workspaceService: WorkspaceService, memoryService: MemoryService): Promise<any> {
        try {
            const { session, traces } = sessionData;
            
            // Get workspace for context
            let workspace: any;
            try {
                workspace = await workspaceService.getWorkspace(session.workspaceId);
            } catch {
                workspace = { name: 'Unknown Workspace' };
            }

            // Build context summary
            const summary = this.buildContextSummary(session, workspace, traces);

            // Get associated notes (files that were mentioned in traces)
            const associatedNotes = this.extractAssociatedNotes(traces);

            return {
                summary,
                associatedNotes,
                sessionCreatedAt: new Date(session.startTime).toISOString(),
                originalSessionId: session.id,
                traces: traces.slice(0, 10).map((trace: any) => ({
                    timestamp: trace.timestamp,
                    content: trace.content.substring(0, 200) + (trace.content.length > 200 ? '...' : ''),
                    type: trace.type,
                    importance: trace.importance
                })),
                tags: session.tags || []
            };

        } catch (error) {
            console.warn('Error building session context:', error);
            return {
                summary: `Session "${sessionData.session.name}" loaded successfully`,
                associatedNotes: [],
                sessionCreatedAt: new Date().toISOString(),
                originalSessionId: sessionData.session.id,
                traces: [],
                tags: []
            };
        }
    }

    /**
     * Create continuation session (consolidated from SessionManager logic)
     */
    private async createContinuationSession(
        params: LoadSessionParams,
        sessionData: any,
        contextResult: any,
        memoryService: MemoryService
    ): Promise<{success: boolean; error?: string; sessionId?: string}> {
        try {
            const originalSession = sessionData.session;

            // Create continuation session
            const continuationData = {
                workspaceId: originalSession.workspaceId,
                name: params.sessionName || `Continuation of "${originalSession.name}"`,
                description: params.sessionDescription || `Continuing session from previous session: ${originalSession.name}`
            };

            const continuationSession = await memoryService.createSession(continuationData);

            return { success: true, sessionId: continuationSession.id };

        } catch (error) {
            console.warn('Warning creating continuation session:', error);
            return { success: false, error: createErrorMessage('Error creating continuation session: ', error) };
        }
    }

    /**
     * Generate restoration summary (consolidated from RestorationSummaryGenerator logic)
     */
    private generateRestorationSummary(sessionData: any, contextResult: any, continuationSessionId?: string): any {
        const originalSession = sessionData.session;
        const traces = sessionData.traces || [];

        const summary = {
            sessionName: originalSession.name,
            originalStartTime: new Date(originalSession.startTime).toLocaleString(),
            workspaceId: originalSession.workspaceId,
            traceCount: traces.length,
            continuationSessionId,
            restorationTime: new Date().toLocaleString(),
            contextSummary: contextResult.summary,
            continuationHistory: undefined as any[] | undefined
        };

        // Add continuation history if applicable
        if (originalSession.previousSessionId) {
            summary['continuationHistory'] = [{
                timestamp: originalSession.startTime,
                description: `Originally continued from session ${originalSession.previousSessionId}`
            }];
        }

        return summary;
    }

    /**
     * Create restoration trace (consolidated from RestorationTracer logic)
     */
    private async createRestorationTrace(
        sessionData: any,
        contextResult: any,
        continuationSessionId: string,
        memoryService: MemoryService
    ): Promise<void> {
        try {
            const originalSession = sessionData.session;
            
            const traceContent = this.buildRestorationTraceContent(
                originalSession,
                contextResult,
                continuationSessionId
            );

            // Create restoration memory trace
            await memoryService.createMemoryTrace({
                sessionId: continuationSessionId,
                workspaceId: originalSession.workspaceId,
                content: traceContent,
                type: 'session_restoration',
                timestamp: Date.now(),
                metadata: {
                    tool: 'loadSession',
                    params: { originalSessionId: originalSession.id },
                    result: { continuationSessionId },
                    relatedFiles: []
                }
            });

        } catch (error) {
            console.warn('Warning creating restoration trace:', error);
            // Don't fail session loading if trace creation fails
        }
    }

    /**
     * Prepare final result
     */
    private prepareFinalResult(sessionData: any, contextResult: any, summaryResult: any, continuationSessionId?: string): SessionResult {
        const originalSession = sessionData.session;
        
        const resultData: any = {
            sessionId: originalSession.id,
            name: originalSession.name,
            workspaceId: originalSession.workspaceId,
            startTime: originalSession.startTime,
            endTime: originalSession.endTime,
            isActive: originalSession.isActive,
            newSessionId: continuationSessionId,
            sessionContext: contextResult,
            restoredContext: {
                summary: contextResult.summary,
                associatedNotes: contextResult.associatedNotes,
                stateCreatedAt: contextResult.sessionCreatedAt,
                originalSessionId: originalSession.id,
                continuationHistory: summaryResult.continuationHistory,
                tags: contextResult.tags
            }
        };

        const contextString = continuationSessionId 
            ? `Loaded session "${originalSession.name}" and created continuation session ${continuationSessionId}`
            : `Loaded session "${originalSession.name}"`;

        return this.prepareResult(
            true,
            resultData,
            undefined,
            contextString
        );
    }

    /**
     * Helper methods (consolidated from various services)
     */
    private buildContextSummary(session: any, workspace: any, traces: any[]): string {
        const parts: string[] = [];
        
        parts.push(`Loaded session: "${session.name}"`);
        parts.push(`Workspace: ${workspace.name}`);
        
        if (session.description) {
            parts.push(`Description: ${session.description}`);
        }
        
        if (session.sessionGoal) {
            parts.push(`Goal: ${session.sessionGoal}`);
        }
        
        if (traces.length > 0) {
            parts.push(`${traces.length} memory traces available`);
        }
        
        const sessionAge = Date.now() - session.startTime;
        const daysAgo = Math.floor(sessionAge / (1000 * 60 * 60 * 24));
        if (daysAgo > 0) {
            parts.push(`Created ${daysAgo} day${daysAgo === 1 ? '' : 's'} ago`);
        } else {
            const hoursAgo = Math.floor(sessionAge / (1000 * 60 * 60));
            if (hoursAgo > 0) {
                parts.push(`Created ${hoursAgo} hour${hoursAgo === 1 ? '' : 's'} ago`);
            } else {
                parts.push('Created recently');
            }
        }
        
        return parts.join('. ');
    }

    private extractAssociatedNotes(traces: any[]): string[] {
        const noteSet = new Set<string>();
        
        traces.forEach(trace => {
            if (trace.content && typeof trace.content === 'string') {
                // Extract file references from trace content
                const fileMatches = trace.content.match(/\b[\w-]+\.md\b/g);
                if (fileMatches) {
                    fileMatches.forEach((match: string) => noteSet.add(match));
                }
            }
        });
        
        return Array.from(noteSet).slice(0, 10); // Limit to 10 notes
    }

    private buildRestorationTraceContent(originalSession: any, contextResult: any, continuationSessionId: string): string {
        const parts: string[] = [];
        
        parts.push(`Session Restoration: Loaded session "${originalSession.name}"`);
        parts.push(`Original session created: ${new Date(originalSession.startTime).toLocaleString()}`);
        parts.push(`Continuation session created: ${continuationSessionId}`);
        parts.push(`Context: ${contextResult.summary}`);
        
        if (contextResult.associatedNotes.length > 0) {
            parts.push(`Associated files: ${contextResult.associatedNotes.slice(0, 5).join(', ')}`);
        }
        
        return parts.join('\n\n');
    }

    /**
     * Schema methods using consolidated logic
     */
    getParameterSchema(): any {
        const baseSchema = this.schemaBuilder.buildParameterSchema(SchemaType.Session, {
            mode: 'loadSession'
        });
        return this.getMergedSchema(baseSchema);
    }

    getResultSchema(): any {
        return this.schemaBuilder.buildResultSchema(SchemaType.Session, {
            mode: 'loadSession'
        });
    }
}