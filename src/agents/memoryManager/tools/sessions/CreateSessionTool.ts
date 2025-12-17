/**
 * Location: /src/agents/memoryManager/modes/sessions/CreateSessionMode.ts
 * Purpose: Consolidated session creation mode combining all create functionality from the original 15+ session files
 * 
 * This file consolidates:
 * - Original createSessionMode.ts functionality
 * - WorkspaceResolver service logic
 * - SessionCreator service logic  
 * - ContextBuilder service logic
 * - MemoryTracer service logic
 * - SessionInstructionManager service logic
 * 
 * Used by: MemoryManager agent for session creation operations
 */

import { App } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { MemoryManagerAgent } from '../../memoryManager'
import { CreateSessionParams, SessionResult } from '../../types';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { extractContextFromParams, WorkspaceContext } from '../../../../utils/contextUtils';
import { MemoryService } from "../../services/MemoryService";
import { WorkspaceService, GLOBAL_WORKSPACE_ID } from '../../../../services/WorkspaceService';
import { createServiceIntegration } from '../../services/ValidationService';
import { SchemaBuilder, SchemaType } from '../../../../utils/schemas/SchemaBuilder';

/**
 * Consolidated CreateSessionMode - combines all session creation functionality
 */
export class CreateSessionTool extends BaseTool<CreateSessionParams, SessionResult> {
    private app: App;
    private serviceIntegration: ReturnType<typeof createServiceIntegration>;
    private schemaBuilder: SchemaBuilder;

    constructor(private agent: MemoryManagerAgent) {
        super(
            'createSession',
            'Create Session', 
            'Creates a new tool activity tracking session with memory context',
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
     * Execute session creation with consolidated logic
     */
    async execute(params: CreateSessionParams): Promise<SessionResult> {
        try {
            // Phase 1: Get services and validate
            const servicesResult = await this.getServices();
            if (!servicesResult.success) {
                return this.prepareResult(false, undefined, servicesResult.error);
            }

            const { memoryService, workspaceService } = servicesResult;

            // Phase 2: Resolve workspace context (consolidated WorkspaceResolver logic)  
            const workspaceResult = await this.resolveWorkspaceContext(params, workspaceService!);
            if (!workspaceResult.success) {
                return this.prepareResult(false, undefined, workspaceResult.error, extractContextFromParams(params));
            }

            // Phase 3: Create session (consolidated SessionCreator logic)
            const sessionResult = await this.createSession(params, workspaceResult.data, memoryService!);
            if (!sessionResult.success) {
                return this.prepareResult(false, undefined, sessionResult.error);
            }

            // Phase 4: Build session context (consolidated ContextBuilder logic)
            const contextResult = await this.buildSessionContext(params, workspaceResult.data, sessionResult.data, workspaceService!);

            // Phase 5: Create memory traces (consolidated MemoryTracer logic)
            if (params.generateContextTrace !== false) {
                await this.createMemoryTraces(params, workspaceResult.data, sessionResult.data, contextResult, memoryService!);
            }

            // Phase 6: Process session instructions (consolidated SessionInstructionManager logic)
            const instructionResult = this.processSessionInstructions(
                sessionResult.data.id,
                this.extractContextString(params),
                sessionResult.data.name
            );

            // Phase 7: Prepare final result
            return this.prepareFinalResult(
                sessionResult.data,
                contextResult,
                instructionResult,
                workspaceResult.data
            );

        } catch (error) {
            return this.prepareResult(false, undefined, createErrorMessage('Error creating session: ', error));
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
     * Resolve workspace context (consolidated from WorkspaceResolver service)
     */
    private async resolveWorkspaceContext(params: CreateSessionParams, workspaceService: WorkspaceService): Promise<{success: boolean; error?: string; data?: any}> {
        try {
            let workspaceId: string;
            let workspace: any;

            // Get workspace from params or inherited context
            const inheritedContext = this.getInheritedWorkspaceContext(params);
            const paramWorkspaceContext = params.workspaceContext;

            if (paramWorkspaceContext) {
                // Parse workspace context if it's a string
                let contextData: WorkspaceContext;
                if (typeof paramWorkspaceContext === 'string') {
                    try {
                        contextData = JSON.parse(paramWorkspaceContext);
                    } catch {
                        return { success: false, error: 'Invalid workspace context JSON format' };
                    }
                } else {
                    contextData = paramWorkspaceContext;
                }

                if (contextData.workspaceId) {
                    workspaceId = contextData.workspaceId;
                } else {
                    workspaceId = GLOBAL_WORKSPACE_ID;
                }
            } else if (inheritedContext?.workspaceId) {
                workspaceId = inheritedContext.workspaceId;
            } else {
                workspaceId = GLOBAL_WORKSPACE_ID;
            }

            // Get the workspace
            workspace = await workspaceService.getWorkspace(workspaceId);
            if (!workspace) {
                return { success: false, error: `Workspace not found: ${workspaceId}` };
            }

            return { success: true, data: { workspaceId, workspace } };

        } catch (error) {
            return { success: false, error: createErrorMessage('Error resolving workspace: ', error) };
        }
    }

    /**
     * Create session (consolidated from SessionCreator service)
     */
    private async createSession(params: CreateSessionParams, workspaceData: any, memoryService: MemoryService): Promise<{success: boolean; error?: string; data?: any}> {
        try {
            const sessionData: { workspaceId: string; name: string; description: string; id?: string } = {
                workspaceId: workspaceData.workspaceId,
                name: params.name || `Session ${new Date().toLocaleString()}`,
                description: params.description || ''
            };

            // Use specific session ID if provided
            if (params.newSessionId) {
                sessionData.id = params.newSessionId;
            }

            const session = await memoryService.createSession(sessionData);
            
            return { success: true, data: session };

        } catch (error) {
            return { success: false, error: createErrorMessage('Error creating session: ', error) };
        }
    }

    /**
     * Build session context (consolidated from ContextBuilder service)
     */
    private async buildSessionContext(params: CreateSessionParams, workspaceData: any, sessionData: any, workspaceService: WorkspaceService): Promise<any> {
        try {
            // Get previous session info if applicable
            let previousSessionInfo = '';
            if (params.previousSessionId) {
                try {
                    const prevSession = await workspaceService.getWorkspace(params.previousSessionId);
                    if (prevSession) {
                        previousSessionInfo = `Previous session: ${prevSession.name}`;
                    }
                } catch {
                    // Ignore errors getting previous session
                }
            }

            // Build context summary
            const summary = this.buildContextSummary(
                workspaceData.workspace,
                params.sessionGoal,
                params.contextDepth || 'standard',
                previousSessionInfo
            );

            return {
                summary,
                associatedNotes: [],
                sessionCreatedAt: new Date().toISOString()
            };

        } catch (error) {
            return {
                summary: 'Session created successfully',
                associatedNotes: [],
                sessionCreatedAt: new Date().toISOString()
            };
        }
    }

    /**
     * Create memory traces (consolidated from MemoryTracer service)
     */
    private async createMemoryTraces(
        params: CreateSessionParams,
        workspaceData: any,
        sessionData: any,
        contextResult: any,
        memoryService: MemoryService
    ): Promise<void> {
        try {
            const contextString = this.extractContextString(params);
            
            const traceContent = this.buildContextTraceContent(
                contextResult.summary,
                contextString,
                params.sessionGoal,
                params.previousSessionId
            );

            // Create memory trace
            await memoryService.createMemoryTrace({
                sessionId: sessionData.id,
                workspaceId: workspaceData.workspaceId,
                content: traceContent,
                type: 'session_creation',
                timestamp: Date.now(),
                metadata: {
                    tool: 'createSession',
                    params: { sessionName: params.name },
                    result: { sessionId: sessionData.id },
                    relatedFiles: []
                }
            });

        } catch (error) {
            // Don't fail session creation if memory trace fails
        }
    }

    /**
     * Process session instructions (consolidated from SessionInstructionManager service)
     */
    private processSessionInstructions(sessionId: string, contextString: string, sessionName: string): any {
        const shouldInclude = contextString && contextString.includes('instruction');
        
        return {
            shouldIncludeInstructions: shouldInclude,
            sessionInstructions: shouldInclude ? `Session "${sessionName}" created with context instructions` : undefined,
            finalContextString: contextString
        };
    }

    /**
     * Prepare final result
     */
    private prepareFinalResult(sessionData: any, contextResult: any, instructionResult: any, workspaceData: any): SessionResult {
        const resultData: any = {
            sessionId: sessionData.id,
            name: sessionData.name,
            description: sessionData.description,
            workspaceId: workspaceData.workspaceId,
            sessionContext: contextResult
        };

        if (instructionResult.shouldIncludeInstructions) {
            resultData.sessionInstructions = instructionResult.sessionInstructions;
        }

        return this.prepareResult(
            true,
            resultData,
            undefined,
            instructionResult.finalContextString
        );
    }

    /**
     * Helper methods (consolidated from various services)
     */
    private extractContextString(params: CreateSessionParams): string {
        if (params.context) {
            // Handle both string and object context types
            if (typeof params.context === 'string') {
                return params.context;
            } else {
                // Use new ToolContext format (memory/goal/constraints)
                const parts: string[] = [];
                if (params.context.goal) parts.push(`Goal: ${params.context.goal}`);
                if (params.context.memory) parts.push(`Memory: ${params.context.memory}`);
                if (params.context.constraints) parts.push(`Constraints: ${params.context.constraints}`);
                return parts.join('. ');
            }
        }

        const parts: string[] = [];
        if (params.sessionGoal) parts.push(`Goal: ${params.sessionGoal}`);
        if (params.description) parts.push(`Description: ${params.description}`);
        if (params.previousSessionId) parts.push(`Continuation from: ${params.previousSessionId}`);

        return parts.join('. ');
    }

    private buildContextSummary(workspace: any, sessionGoal?: string, contextDepth: string = 'standard', previousSessionInfo?: string): string {
        const parts: string[] = [];
        
        parts.push(`Session started in workspace: ${workspace.name}`);
        if (sessionGoal) parts.push(`Goal: ${sessionGoal}`);
        if (previousSessionInfo) parts.push(previousSessionInfo);
        
        if (contextDepth === 'comprehensive' && workspace.context) {
            parts.push(`Workspace purpose: ${workspace.context.purpose}`);
            if (workspace.context.currentGoal) {
                parts.push(`Workspace goal: ${workspace.context.currentGoal}`);
            }
        }
        
        return parts.join('. ');
    }

    private buildContextTraceContent(summary: string, contextString: string, sessionGoal?: string, previousSessionId?: string): string {
        const parts: string[] = [];
        
        parts.push(`Session Context: ${summary}`);
        if (contextString) parts.push(`Details: ${contextString}`);
        if (sessionGoal) parts.push(`Session Goal: ${sessionGoal}`);
        if (previousSessionId) parts.push(`Continues from session: ${previousSessionId}`);
        
        return parts.join('\n\n');
    }

    /**
     * Schema methods using consolidated logic
     */
    getParameterSchema(): any {
        const baseSchema = this.schemaBuilder.buildParameterSchema(SchemaType.Session, {
            mode: 'createSession'
        });
        return this.getMergedSchema(baseSchema);
    }

    getResultSchema(): any {
        return this.schemaBuilder.buildResultSchema(SchemaType.Session, {
            mode: 'createSession'
        });
    }
}