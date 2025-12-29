import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
/**
 * Location: /src/agents/memoryManager/modes/states/CreateStateMode.ts
 * Purpose: Consolidated state creation mode combining all create functionality from original state files
 * 
 * This file consolidates:
 * - Original createStateMode.ts functionality
 * - StateCreator service logic
 * - Parameter validation logic
 * - Context building and tracing logic
 * 
 * Used by: MemoryManager agent for state creation operations
 */

import { App } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { MemoryManagerAgent } from '../../memoryManager'
import { CreateStateParams, StateResult } from '../../types';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { extractContextFromParams } from '../../../../utils/contextUtils';
import { MemoryService } from "../../services/MemoryService";
import { WorkspaceService, GLOBAL_WORKSPACE_ID } from '../../../../services/WorkspaceService';
import { createServiceIntegration, ValidationError } from '../../services/ValidationService';
import { SchemaBuilder, SchemaType } from '../../../../utils/schemas/SchemaBuilder';

/**
 * Consolidated CreateStateMode - combines all state creation functionality
 */
export class CreateStateTool extends BaseTool<CreateStateParams, StateResult> {
    private app: App;
    private serviceIntegration: ReturnType<typeof createServiceIntegration>;
    private schemaBuilder: SchemaBuilder;

    constructor(private agent: MemoryManagerAgent) {
        super(
            'createState',
            'Create State',
            'Create a state with restoration context for later resumption',
            '2.0.0'
        );

        this.app = agent.getApp();
        this.serviceIntegration = createServiceIntegration(this.app, {
            logLevel: 'warn',
            maxRetries: 3,
            fallbackBehavior: 'warn'
        });
        this.schemaBuilder = new SchemaBuilder();
    }

    /**
     * Execute state creation with consolidated logic
     */
    async execute(params: CreateStateParams): Promise<StateResult> {
        const startTime = Date.now();
        
        try {
            // Phase 1: Get services and validate
            const servicesResult = await this.getServices();
            if (!servicesResult.success) {
                return this.prepareResult(false, undefined, servicesResult.error);
            }

            const { memoryService, workspaceService } = servicesResult;
            
            // Ensure services are available
            if (!memoryService || !workspaceService) {
                return this.prepareResult(false, undefined, 'Required services not available');
            }

            // Phase 2: Validate parameters (consolidated validation logic)
            const validationErrors = this.validateParameters(params);
            if (validationErrors.length > 0) {
                const errorMessages = validationErrors.map(e => `${e.field}: ${e.requirement}`).join('\n');
                return this.prepareResult(
                    false,
                    undefined,
                    `Missing required parameters:\n${errorMessages}`,
                    extractContextFromParams(params)
                );
            }

            // Phase 3: Resolve workspace context (consolidated workspace resolution)
            const workspaceResult = await this.resolveWorkspaceContext(params, workspaceService);
            if (!workspaceResult.success) {
                return this.prepareResult(false, undefined, workspaceResult.error, extractContextFromParams(params));
            }

            // Phase 3.5: Check state name uniqueness (states are workspace-scoped using '_workspace' as sessionId)
            const existingStates = await memoryService.getStates(workspaceResult.data.workspaceId, '_workspace');
            const nameExists = existingStates.items.some(state => state.name === params.name);
            if (nameExists) {
                return this.prepareResult(
                    false,
                    undefined,
                    `State "${params.name}" already exists. States are immutable - use a unique name like "${params.name}-v2" or "${params.name}-${new Date().toISOString().split('T')[0]}".`,
                    extractContextFromParams(params)
                );
            }

            // Phase 4: Build state context (consolidated from StateCreator logic)
            const contextResult = await this.buildStateContext(params, workspaceResult.data, workspaceService);

            // Phase 5: Create and persist state (consolidated persistence logic)
            const persistResult = await this.createAndPersistState(params, workspaceResult.data, contextResult, memoryService);
            if (!persistResult.success) {
                return this.prepareResult(false, undefined, persistResult.error, extractContextFromParams(params));
            }
            
            // Ensure stateId is available
            if (!persistResult.stateId) {
                return this.prepareResult(false, undefined, 'State creation failed - no state ID returned', extractContextFromParams(params));
            }

            // Extract workspaceId for verification (use '_workspace' as sessionId)
            const workspaceId = workspaceResult.data.workspaceId;

            // Phase 6: Verify persistence (data integrity check)
            const verificationResult = await this.verifyStatePersistence(workspaceId, '_workspace', persistResult.stateId, memoryService);
            if (!verificationResult.success) {
                // Rollback if verification fails
                await this.rollbackState(workspaceId, '_workspace', persistResult.stateId, memoryService);
                return this.prepareResult(false, undefined, `State verification failed: ${verificationResult.error}`, extractContextFromParams(params));
            }

            // Phase 7: Prepare final result
            return this.prepareFinalResult(
                persistResult.stateId,
                persistResult.savedState,
                contextResult,
                workspaceResult.data,
                startTime,
                params
            );

        } catch (error) {
            const errorMsg = createErrorMessage('Error creating state: ', error);
            return this.prepareResult(
                false, 
                {
                    error: errorMsg,
                    parameterHints: '💡 Check that all required parameters are correctly formatted:\n- name: string\n- conversationContext: string (what was happening)\n- activeTask: string (what you were working on)\n- activeFiles: array of file paths\n- nextSteps: array of action items',
                    suggestions: [
                        'Verify all required fields are provided',
                        'Ensure activeFiles is an array: ["file1.md", "file2.md"]',
                        'Ensure nextSteps is an array: ["Step 1", "Step 2", "Step 3"]',
                        'Check that workspace context is available',
                        'Verify memory service is initialized'
                    ],
                    providedParams: params
                }, 
                errorMsg,
                extractContextFromParams(params)
            );
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
     * Validate state creation parameters (consolidated validation logic)
     */
    private validateParameters(params: CreateStateParams): ValidationError[] {
        const errors: ValidationError[] = [];

        // Required fields validation
        if (!params.name || typeof params.name !== 'string' || params.name.trim() === '') {
            errors.push({
                field: 'name',
                value: params.name,
                requirement: 'Name is required and must be a non-empty string'
            });
        }

        if (!params.conversationContext || typeof params.conversationContext !== 'string' || params.conversationContext.trim() === '') {
            errors.push({
                field: 'conversationContext',
                value: params.conversationContext,
                requirement: 'Conversation context is required and must be a non-empty string'
            });
        }

        if (!params.activeTask || typeof params.activeTask !== 'string' || params.activeTask.trim() === '') {
            errors.push({
                field: 'activeTask',
                value: params.activeTask,
                requirement: 'Active task is required and must be a non-empty string'
            });
        }

        if (!Array.isArray(params.activeFiles)) {
            errors.push({
                field: 'activeFiles',
                value: params.activeFiles,
                requirement: 'Active files is required and must be an array'
            });
        }

        if (!Array.isArray(params.nextSteps)) {
            errors.push({
                field: 'nextSteps',
                value: params.nextSteps,
                requirement: 'Next steps is required and must be an array'
            });
        }

        return errors;
    }

    /**
     * Resolve workspace context (consolidated workspace resolution)
     */
    private async resolveWorkspaceContext(params: CreateStateParams, workspaceService: WorkspaceService): Promise<{success: boolean; error?: string; data?: any}> {
        try {
            // Get workspace from inherited context or use global workspace
            const inheritedContext = this.getInheritedWorkspaceContext(params);
            let workspaceId: string;
            
            if (inheritedContext?.workspaceId) {
                workspaceId = inheritedContext.workspaceId;
            } else {
                workspaceId = GLOBAL_WORKSPACE_ID;
            }

            // Get the workspace to capture its current context
            const workspace = await workspaceService.getWorkspace(workspaceId);
            if (!workspace) {
                return { success: false, error: `Workspace not found: ${workspaceId}` };
            }

            return { success: true, data: { workspaceId, workspace } };

        } catch (error) {
            return { success: false, error: createErrorMessage('Error resolving workspace: ', error) };
        }
    }

    /**
     * Build state context (consolidated from StateCreator logic)
     */
    private async buildStateContext(params: CreateStateParams, workspaceData: any, workspaceService: WorkspaceService): Promise<any> {
        const { workspace } = workspaceData;

        // Extract or create workspace context
        let currentWorkspaceContext;
        if (workspace.context) {
            currentWorkspaceContext = workspace.context;
        } else {
            // Create basic context for legacy workspace
            currentWorkspaceContext = {
                purpose: workspace.description || `Work in ${workspace.name}`,
                workflows: [],
                keyFiles: [],
                preferences: ''
            };
        }

        // Build the state context from LLM input (no reasoning field)
        const context = {
            workspaceContext: currentWorkspaceContext,
            conversationContext: params.conversationContext,
            activeTask: params.activeTask,
            activeFiles: params.activeFiles,
            nextSteps: params.nextSteps
        };

        return {
            context,
            workspaceContext: currentWorkspaceContext
        };
    }

    /**
     * Create and persist state (consolidated persistence logic)
     */
    private async createAndPersistState(
        params: CreateStateParams,
        workspaceData: any,
        contextResult: any,
        memoryService: MemoryService
    ): Promise<{success: boolean; error?: string; stateId?: string; savedState?: any}> {
        try {
            const { workspaceId, workspace } = workspaceData;
            const { context } = contextResult;
            const now = Date.now();

            // Build WorkspaceState for storage following the architecture design
            // This matches the WorkspaceState interface which extends State
            // Use '_workspace' as sessionId for workspace-scoped states
            const workspaceState = {
                // Core State fields (required)
                id: `state_${now}_${Math.random().toString(36).substring(2, 11)}`,
                name: params.name,
                workspaceId: workspaceId,
                created: now,
                context: context,  // The inner StateContext with activeTask, activeFiles, etc.

                // Additional WorkspaceState fields
                sessionId: '_workspace',  // All states are workspace-scoped
                timestamp: now,
                state: {
                    workspace,
                    recentTraces: [], // Could be populated from current session
                    contextFiles: params.activeFiles || [],
                    metadata: {
                        createdBy: 'CreateStateMode',
                        version: '2.0.0',
                        creationMethod: 'manual',
                        tags: params.tags || []
                    }
                }
            };

            // Persist to MemoryService - use '_workspace' as sessionId
            const stateId = await memoryService.saveState(
                workspaceId,
                '_workspace',
                workspaceState,  // Pass the full object
                workspaceState.name
            );

            return { success: true, stateId, savedState: workspaceState };

        } catch (error) {
            return { success: false, error: createErrorMessage('Error persisting state: ', error) };
        }
    }

    /**
     * Verify that a state was properly persisted
     */
    private async verifyStatePersistence(workspaceId: string, sessionId: string, stateId: string, memoryService: MemoryService): Promise<{success: boolean; error?: string}> {
        try {
            // getState returns WorkspaceState which has a context property
            const retrieved = await memoryService.getState(workspaceId, sessionId, stateId);
            if (!retrieved) {
                return { success: false, error: 'State not found after creation' };
            }

            // Verify essential context fields
            if (!retrieved.context || !retrieved.context.activeTask) {
                return { success: false, error: 'State data incomplete after persistence - missing context.activeTask' };
            }

            if (!retrieved.workspaceId || !retrieved.name) {
                return { success: false, error: 'Critical state fields missing after persistence - missing workspaceId or name' };
            }

            return { success: true };
        } catch (error) {
            return { success: false, error: createErrorMessage('Verification failed: ', error) };
        }
    }

    /**
     * Rollback a state creation if verification fails
     */
    private async rollbackState(workspaceId: string, sessionId: string, stateId: string, memoryService: MemoryService): Promise<void> {
        try {
            await memoryService.deleteState(workspaceId, sessionId, stateId);
            // State rolled back silently - error will be reported through main flow
        } catch (error) {
            // Rollback failure is not critical - verification failure is the primary issue
            // Don't log or throw here to avoid noise
        }
    }

    /**
     * Prepare final result - simplified to just return success
     */
    private prepareFinalResult(
        stateId: string,
        savedState: any,
        contextResult: any,
        workspaceData: any,
        startTime: number,
        params: CreateStateParams
    ): StateResult {
        // Success - LLM already knows the state details it passed
        return this.prepareResult(true);
    }

    /**
     * Schema methods using consolidated logic
     */
    getParameterSchema(): JSONSchema {
        const toolSchema = {
            type: 'object',
            title: 'Create State',
            description: 'Save current work context for later resumption. States are immutable snapshots.',
            properties: {
                name: {
                    type: 'string',
                    description: 'Short descriptive title for this save point'
                },
                conversationContext: {
                    type: 'string',
                    description: 'Detailed markdown summary enabling seamless resumption. Structure with headings:\n\n## Original Request\nWhat the user asked for and their goal\n\n## Key Decisions Made\n- Decision and reasoning\n- Decision and reasoning\n\n## Important Context\nBackground info, constraints, or discoveries from the conversation\n\n## Current Status\nWhat is complete, what is in progress, any blockers'
                },
                activeTask: {
                    type: 'string',
                    description: 'The specific task in progress when saving'
                },
                activeFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'File paths being edited or referenced'
                },
                nextSteps: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Specific action items to resume work, in priority order'
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional tags for categorization'
                }
            },
            required: ['name', 'conversationContext', 'activeTask', 'activeFiles', 'nextSteps'],
            additionalProperties: false
        };
        
        return this.getMergedSchema(toolSchema);
    }

    getResultSchema(): JSONSchema {
        return this.schemaBuilder.buildResultSchema(SchemaType.State, {
            mode: 'createState'
        });
    }
}