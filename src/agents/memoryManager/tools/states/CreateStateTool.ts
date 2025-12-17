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
import { CommonParameters } from '../../../../types/mcp/AgentTypes';
import { addRecommendations } from '../../../../utils/recommendationUtils';

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
                const missingFields = validationErrors.map(e => e.field).join(', ');
                
                return this.prepareResult(
                    false, 
                    {
                        error: `❌ Validation Failed - Missing or invalid required parameters: ${missingFields}\n\n${errorMessages}`,
                        validationErrors: validationErrors,
                        parameterHints: `💡 All Required Parameters:\n- name: string (descriptive name for this state)\n- conversationContext: string (what was happening)\n- activeTask: string (what you were working on)\n- activeFiles: array of file paths\n- nextSteps: array of action items\n- reasoning: string (why saving now)`,
                        suggestions: [
                            'Ensure ALL required parameters are provided',
                            'name is REQUIRED - provide a descriptive name for this state',
                            'activeFiles must be an array of file paths, e.g., ["file1.md", "file2.md"]',
                            'nextSteps must be an array of action items, e.g., ["Step 1", "Step 2"]',
                            'All text fields (name, conversationContext, activeTask, reasoning) must be non-empty strings'
                        ],
                        providedParams: params,
                        expectedParams: {
                            name: 'string (REQUIRED)',
                            conversationContext: 'string (REQUIRED)',
                            activeTask: 'string (REQUIRED)',
                            activeFiles: 'array of strings (REQUIRED)',
                            nextSteps: 'array of strings (REQUIRED)',
                            reasoning: 'string (REQUIRED)'
                        }
                    }, 
                    `Validation failed: ${missingFields} - ${errorMessages}`,
                    extractContextFromParams(params)
                );
            }

            // Phase 3: Resolve workspace context (consolidated workspace resolution)
            const workspaceResult = await this.resolveWorkspaceContext(params, workspaceService);
            if (!workspaceResult.success) {
                return this.prepareResult(false, undefined, workspaceResult.error, extractContextFromParams(params));
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

            // Extract workspaceId and sessionId for verification
            const workspaceId = workspaceResult.data.workspaceId;
            const sessionId = params.targetSessionId || params.context?.sessionId || 'current';

            // Phase 6: Verify persistence (data integrity check)
            const verificationResult = await this.verifyStatePersistence(workspaceId, sessionId, persistResult.stateId, memoryService);
            if (!verificationResult.success) {
                // Rollback if verification fails
                await this.rollbackState(workspaceId, sessionId, persistResult.stateId, memoryService);
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
                    parameterHints: '💡 Check that all required parameters are correctly formatted:\n- name: string\n- conversationContext: string (what was happening)\n- activeTask: string (what you were working on)\n- activeFiles: array of file paths\n- nextSteps: array of action items\n- reasoning: string (why saving now)',
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
        // Use consolidated validation service
        const errors = this.serviceIntegration.validateStateCreationParams(params);
        
        // Add any additional state-specific validations
        if (params.maxFiles !== undefined && params.maxFiles < 0) {
            errors.push({
                field: 'maxFiles',
                value: params.maxFiles,
                requirement: 'Maximum files must be a non-negative number'
            });
        }

        if (params.maxTraces !== undefined && params.maxTraces < 0) {
            errors.push({
                field: 'maxTraces',
                value: params.maxTraces,
                requirement: 'Maximum traces must be a non-negative number'
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
                currentGoal: 'Continue workspace tasks',
                status: 'In progress',
                workflows: [],
                keyFiles: [],
                preferences: [],
                agents: [],
            };
        }

        // Build the state context from LLM input
        const context = {
            workspaceContext: currentWorkspaceContext,
            conversationContext: params.conversationContext,
            activeTask: params.activeTask,
            activeFiles: params.activeFiles || [],
            nextSteps: params.nextSteps || [],
            reasoning: params.reasoning
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
            const workspaceState = {
                // Core State fields (required)
                id: `state_${now}_${Math.random().toString(36).substring(2, 11)}`,
                name: params.name,
                workspaceId: workspaceId,
                created: now,
                context: context,  // The inner StateContext with activeTask, activeFiles, etc.

                // Additional WorkspaceState fields
                sessionId: params.targetSessionId || params.context?.sessionId || 'current',
                timestamp: now,
                description: `${params.activeTask} - ${params.reasoning}`,
                state: {
                    workspace,
                    recentTraces: [], // Could be populated from current session
                    contextFiles: params.activeFiles || [],
                    metadata: {
                        createdBy: 'CreateStateMode',
                        version: '2.0.0',
                        creationMethod: 'manual',
                        includeSummary: params.includeSummary || false,
                        includeFileContents: params.includeFileContents || false,
                        maxFiles: params.maxFiles,
                        maxTraces: params.maxTraces,
                        reason: params.reason,
                        tags: params.tags || []
                    }
                }
            };

            // Persist to MemoryService - pass the full WorkspaceState
            const sessionId = params.targetSessionId || params.context?.sessionId || 'current';
            const stateId = await memoryService.saveState(
                workspaceId,
                sessionId,
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
     * Prepare final result
     */
    private prepareFinalResult(
        stateId: string,
        savedState: any,
        contextResult: any,
        workspaceData: any,
        startTime: number,
        params: CreateStateParams
    ): StateResult {
        const { workspace } = workspaceData;

        const resultData = {
            stateId: savedState.id,
            name: savedState.name,
            workspaceId: savedState.workspaceId,
            sessionId: savedState.sessionId,
            timestamp: savedState.timestamp,
            created: savedState.created,
            summary: `State "${savedState.name}" saved successfully. Task: ${contextResult.context.activeTask}`,
            metadata: {
                persistenceVerified: true,
                workspaceName: workspace.name,
                totalActiveFiles: contextResult.context.activeFiles.length,
                nextStepsCount: contextResult.context.nextSteps.length
            },
            capturedContext: {
                summary: `${contextResult.context.activeTask} - ${contextResult.context.reasoning}`,
                conversationContext: contextResult.context.conversationContext,
                activeFiles: contextResult.context.activeFiles,
                nextSteps: contextResult.context.nextSteps
            },
            performance: {
                totalDuration: Date.now() - startTime,
                persistenceVerified: true
            }
        };

        const contextString = `State "${savedState.name}" created and persisted successfully with ID: ${savedState.id}`;
        // Use new ToolContext format
        const workspaceContext = this.getInheritedWorkspaceContext({
            context: params.context,
            workspaceContext: { workspaceId: workspaceData.workspaceId }
        } as CommonParameters);

        const result = this.prepareResult(
            true,
            resultData,
            undefined,
            contextString,
            workspaceContext || undefined
        );

        // Add standardized recommendation
        return addRecommendations(result, [
            {
                type: "workspace_update",
                message: "STRONGLY RECOMMENDED: Use the updateWorkspace tool to ensure you have the latest workspace information (such as preferences, workflow, etc.) based on this conversation before proceeding with any tasks."
            }
        ]);
    }

    /**
     * Schema methods using consolidated logic
     */
    getParameterSchema(): any {
        const customSchema = {
            type: 'object',
            title: 'Create State - Save Work Context for Resumption',
            description: '⚠️ CRITICAL: "name" is the FIRST required parameter - provide a short descriptive title. Create a state to save your current work context for later resumption.',
            properties: {
                name: {
                    type: 'string',
                    description: '📝 ⚠️ REQUIRED (FIRST PARAMETER): State name - a short descriptive title for this save point. This is DIFFERENT from "reason". Example: "Google Cover Letter Draft"',
                    examples: ['Google Cover Letter Draft', 'Pre-Submission Checkpoint', 'Research Phase Complete', 'Story Outline v1']
                },
                conversationContext: {
                    type: 'string',
                    description: '💬 REQUIRED: What was happening when you decided to save this state? Provide a summary of the conversation and what you were working on.\n\nExample: "We were customizing the cover letter for Google\'s Marketing Manager position. We researched their team and identified key requirements."',
                    examples: [
                        'We were customizing the cover letter for Google\'s Marketing Manager position. We researched their team and identified key requirements.',
                        'Working on the story outline, just completed act 2 structure with key plot points',
                        'Analyzed research papers on AI safety, identified three main themes'
                    ]
                },
                activeTask: {
                    type: 'string',
                    description: '🎯 REQUIRED: What task were you actively working on? Be specific about the current task.\n\nExample: "Finishing the cover letter paragraph about data-driven campaign optimization results"',
                    examples: [
                        'Finishing the cover letter paragraph about data-driven campaign optimization results',
                        'Writing the climax sequence for Act 3',
                        'Summarizing findings from latest AI safety papers'
                    ]
                },
                activeFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '📄 REQUIRED: Which files were you working with? Provide an ARRAY of file paths that were being edited or referenced.\n\nExample: ["cover-letter-google.md", "application-tracker.md"]',
                    examples: [
                        ['cover-letter-google.md', 'application-tracker.md'],
                        ['story-outline.md', 'character-profiles.md'],
                        ['research-notes.md', 'literature-review.md']
                    ]
                },
                nextSteps: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '✅ REQUIRED: What are the immediate next steps when you resume? Provide an ARRAY of specific actionable next steps.\n\nExample: ["Complete cover letter customization", "Review resume for Google-specific keywords", "Submit application"]',
                    examples: [
                        ['Complete cover letter customization', 'Review resume for Google-specific keywords', 'Submit application'],
                        ['Revise Act 3 climax', 'Add character development notes', 'Draft beat sheet'],
                        ['Complete literature review', 'Organize findings by theme', 'Start writing methodology section']
                    ]
                },
                reasoning: {
                    type: 'string',
                    description: '💭 REQUIRED: Why are you saving this state right now? Explain the reason for saving at this point.\n\nExample: "Saving before context limit, about to submit application"',
                    examples: [
                        'Saving before context limit, about to submit application',
                        'Good stopping point before switching to beat sheet work',
                        'Checkpoint before analysis phase, want to preserve research findings'
                    ]
                },
                
                // Optional fields
                description: { 
                    type: 'string', 
                    description: '📋 Optional: Additional description for the state' 
                },
                targetSessionId: { 
                    type: 'string', 
                    description: '🔗 Optional: Target session ID (defaults to current session)' 
                },
                includeSummary: { 
                    type: 'boolean', 
                    description: '📊 Optional: Whether to include a summary (default: false)' 
                },
                includeFileContents: { 
                    type: 'boolean', 
                    description: '📄 Optional: Whether to include file contents (default: false)' 
                },
                maxFiles: { 
                    type: 'number', 
                    description: '🔢 Optional: Maximum number of files to include (must be non-negative)',
                    minimum: 0
                },
                maxTraces: { 
                    type: 'number', 
                    description: '🔢 Optional: Maximum number of memory traces to include (must be non-negative)',
                    minimum: 0
                },
                tags: { 
                    type: 'array', 
                    items: { type: 'string' }, 
                    description: '🏷️ Optional: Tags to associate with the state (array of strings)',
                    examples: [['work', 'cover-letter'], ['screenplay', 'outline'], ['research', 'ai-safety']]
                },
                reason: { 
                    type: 'string', 
                    description: '📝 Optional: Additional reason for creating this state (NOT the same as "name" or "reasoning")' 
                }
            },
            required: ['name', 'conversationContext', 'activeTask', 'activeFiles', 'nextSteps', 'reasoning'],
            additionalProperties: false,
            errorHelp: {
                missingName: '⚠️ CRITICAL: The "name" parameter is REQUIRED and must come first. This is a short title for the state, NOT the same as "reason". Example: { "name": "Google Cover Letter Draft", ... }',
                missingConversationContext: 'The "conversationContext" parameter is required. Explain what was happening when you decided to save.',
                missingActiveTask: 'The "activeTask" parameter is required. Describe what specific task you were working on.',
                missingActiveFiles: 'The "activeFiles" parameter is required. Provide an array of file paths you were working with.',
                missingNextSteps: 'The "nextSteps" parameter is required. Provide an array of actionable next steps for when you resume.',
                missingReasoning: 'The "reasoning" parameter is required. Explain why you\'re saving this state right now.',
                arrayFormat: 'activeFiles and nextSteps must be ARRAYS of strings, not single strings or comma-separated values.',
                commonMistakes: [
                    '⚠️ Forgetting the "name" parameter (most common mistake!) - name is REQUIRED',
                    'Confusing "name" with "reason" - they are different parameters',
                    'Providing activeFiles as a string instead of an array - wrap in brackets: ["file.md"]',
                    'Providing nextSteps as a string instead of an array - wrap in brackets: ["Step 1", "Step 2"]',
                    'Forgetting to include all required fields',
                    'Using negative numbers for maxFiles or maxTraces'
                ]
            }
        };
        
        return this.getMergedSchema(customSchema);
    }

    getResultSchema(): any {
        return this.schemaBuilder.buildResultSchema(SchemaType.State, {
            mode: 'createState'
        });
    }
}