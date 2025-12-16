/**
 * Execute Prompt Mode - Orchestrates LLM prompt execution workflow
 * Follows Single Responsibility Principle by delegating specialized tasks to services
 */

import { BaseMode } from '../../../baseMode';
import { CommonResult, CommonParameters } from '../../../../types';
import { createResult, getCommonResultSchema } from '../../../../utils/schemaUtils';
import { LLMProviderManager } from '../../../../services/llm/providers/ProviderManager';
import { CustomPromptStorageService } from '../../services/CustomPromptStorageService';
import { AgentManager } from '../../../../services/AgentManager';
import { UsageTracker, BudgetStatus } from '../../../../services/UsageTracker';
import { 
    DependencyValidator, 
    PromptExecutor, 
    ActionExecutor, 
    BudgetManager,
    ServiceDependencies
} from './services';
import { addRecommendations, Recommendation } from '../../../../utils/recommendationUtils';
import { NudgeHelpers } from '../../../../utils/nudgeHelpers';
import { parseWorkspaceContext } from '../../../../utils/contextUtils';

export interface ExecutePromptParams extends CommonParameters {
    agent?: string;
    filepaths?: string[];
    prompt: string;
    provider?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    returnContent?: boolean;
    webSearch?: boolean;
    action?: {
        type: 'create' | 'append' | 'prepend' | 'replace' | 'findReplace';
        targetPath: string;
        position?: number;
        findText?: string;
        replaceAll?: boolean;
        caseSensitive?: boolean;
        wholeWord?: boolean;
    };
    // sessionId, context, workspaceContext now inherited from CommonParameters
}

export interface ExecutePromptResult extends CommonResult {
    data: {
        response: string;
        model: string;
        provider: string;
        agentUsed: string;
        usage?: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
        };
        cost?: {
            inputCost: number;
            outputCost: number;
            totalCost: number;
            currency: string;
        };
        budgetStatus?: BudgetStatus;
        filesIncluded?: string[];
        actionPerformed?: {
            type: string;
            targetPath: string;
            success: boolean;
            error?: string;
        };
    };
}

/**
 * Main orchestrator for prompt execution workflow
 * Delegates specialized tasks to focused services following SOLID principles
 */
export class ExecutePromptMode extends BaseMode<ExecutePromptParams, ExecutePromptResult> {
    private dependencyValidator: DependencyValidator;
    private promptExecutor: PromptExecutor;
    private actionExecutor: ActionExecutor;
    private budgetManager: BudgetManager;

    constructor(dependencies?: ServiceDependencies) {
        super(
            'executePrompt',
            'Execute Prompt',
            'Execute an LLM prompt using a custom agent with optional file content and ContentManager actions',
            '1.0.0'
        );

        // Use provided dependencies or initialize with nulls for backward compatibility
        const deps: ServiceDependencies = dependencies || {
            providerManager: null,
            promptStorage: null,
            agentManager: null,
            usageTracker: null
        };

        this.dependencyValidator = new DependencyValidator(deps);
        this.promptExecutor = new PromptExecutor(deps.providerManager!, deps.promptStorage!);
        this.actionExecutor = new ActionExecutor(deps.agentManager);
        this.budgetManager = new BudgetManager(deps.usageTracker);
    }

    /**
     * Set the provider manager instance
     */
    setProviderManager(providerManager: LLMProviderManager): void {
        this.dependencyValidator.updateDependencies({ providerManager });
        this.promptExecutor = new PromptExecutor(providerManager, this.promptExecutor['promptStorage']);
    }

    /**
     * Set the prompt storage service
     */
    setPromptStorage(promptStorage: CustomPromptStorageService): void {
        this.dependencyValidator.updateDependencies({ promptStorage });
        this.promptExecutor = new PromptExecutor(this.promptExecutor['providerManager'], promptStorage);
    }

    /**
     * Set the usage tracker for LLM cost tracking
     */
    setUsageTracker(usageTracker: UsageTracker): void {
        this.dependencyValidator.updateDependencies({ usageTracker });
        this.budgetManager.updateUsageTracker(usageTracker);
    }

    /**
     * Set the agent manager for action operations
     */
    setAgentManager(agentManager: AgentManager): void {
        this.dependencyValidator.updateDependencies({ agentManager });
        this.actionExecutor.updateAgentManager(agentManager);
    }

    /**
     * Execute the prompt mode using service orchestration
     */
    async execute(params: ExecutePromptParams): Promise<ExecutePromptResult> {
        try {
            // Phase 1: Validate dependencies
            const dependencyValidation = await this.dependencyValidator.validateDependencies();
            if (!dependencyValidation.isValid) {
                return createResult<ExecutePromptResult>(
                    false,
                    undefined,
                    dependencyValidation.error!,
                    undefined,
                    undefined,
                    params.context.sessionId,
                    params.context
                );
            }

            // Phase 2: Validate custom agent if specified
            if (params.agent) {
                const agentValidation = await this.dependencyValidator.validateCustomPromptAgent(params.agent);
                if (!agentValidation.isValid) {
                    return createResult<ExecutePromptResult>(
                        false,
                        undefined,
                        agentValidation.error!,
                        undefined,
                        undefined,
                        params.context.sessionId,
                        params.context
                    );
                }
            }

            // Phase 3: Validate budget
            const budgetValidation = await this.budgetManager.validateBudget();
            if (!budgetValidation.isValid) {
                return createResult<ExecutePromptResult>(
                    false,
                    undefined,
                    budgetValidation.error!,
                    undefined,
                    undefined,
                    params.context.sessionId,
                    params.context
                );
            }

            // Phase 4: Execute prompt
            const promptResult = await this.promptExecutor.executePrompt(params);
            if (!promptResult.success) {
                return createResult<ExecutePromptResult>(
                    false,
                    undefined,
                    promptResult.error!,
                    undefined,
                    undefined,
                    params.context.sessionId,
                    params.context
                );
            }

            // Phase 5: Track usage
            let finalBudgetStatus: BudgetStatus | undefined = budgetValidation.budgetStatus;
            if (promptResult.cost && promptResult.provider) {
                const usageResult = await this.budgetManager.trackUsage(
                    promptResult.provider,
                    promptResult.cost.totalCost
                );
                if (usageResult.success && usageResult.budgetStatus) {
                    finalBudgetStatus = usageResult.budgetStatus;
                }
            }

            // Phase 6: Execute action if specified
            const actionResult = await this.actionExecutor.executeAction(
                params,
                promptResult.response || '',
                promptResult.webSearchResults
            );

            // Phase 7: Build result
            const resultData: ExecutePromptResult['data'] = {
                response: (params.returnContent ?? true) ? (promptResult.response || '') : '[Content not returned]',
                model: promptResult.model || 'unknown',
                provider: promptResult.provider || 'unknown',
                agentUsed: promptResult.agentUsed,
                usage: promptResult.usage,
                cost: promptResult.cost,
                budgetStatus: finalBudgetStatus,
                filesIncluded: promptResult.filesIncluded,
                actionPerformed: actionResult.actionPerformed
            };

            const result = createResult<ExecutePromptResult>(
                true,
                resultData,
                undefined,
                undefined,
                undefined,
                params.context.sessionId,
                params.context
            );
            
            // Dynamic nudges based on context
            const hasWorkspace = !!parseWorkspaceContext(params.workspaceContext)?.workspaceId;
            const nudges: Recommendation[] = [NudgeHelpers.suggestCaptureProgress()];
            const agentNudge = NudgeHelpers.checkAgentCreationOpportunity(hasWorkspace);
            if (agentNudge) nudges.push(agentNudge);

            return addRecommendations(result, nudges);

        } catch (error) {
            return createResult<ExecutePromptResult>(
                false,
                undefined,
                `Failed to execute prompt: ${error instanceof Error ? error.message : 'Unknown error'}`,
                undefined,
                undefined,
                params.context.sessionId,
                params.context
            );
        }
    }

    /**
     * Get parameter schema for the mode
     */
    getParameterSchema(): any {
        // Get default from data.json settings
        const providerManager = this.dependencyValidator.getDependencies().providerManager;
        const defaultModel = providerManager?.getSettings()?.defaultModel;
        
        const customSchema = {
            properties: {
                agent: {
                    type: 'string',
                    description: 'Custom prompt agent name or ID to use as system prompt (optional - if not provided, uses raw prompt only). Accepts either the unique agent ID or the agent name.'
                },
                filepaths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional array of file paths to include content as context'
                },
                prompt: {
                    type: 'string',
                    description: 'User prompt/question to send to the LLM'
                },
                provider: {
                    type: 'string',
                    description: `LLM provider (defaults to: ${defaultModel?.provider || 'not configured'}). Use listModels to see available providers.`,
                    default: defaultModel?.provider
                },
                model: {
                    type: 'string',
                    description: `Model name (defaults to: ${defaultModel?.model || 'not configured'}). Use listModels to see available models.`,
                    default: defaultModel?.model
                },
                temperature: {
                    type: 'number',
                    minimum: 0,
                    maximum: 1,
                    description: 'Temperature setting for response randomness (0.0-1.0)'
                },
                maxTokens: {
                    type: 'number',
                    description: 'Maximum tokens to generate'
                },
                returnContent: {
                    type: 'boolean',
                    description: 'Whether to return the LLM response content in the result (defaults to true)',
                    default: true
                },
                webSearch: {
                    type: 'boolean',
                    description: 'Enable web search for current information (supported by: perplexity, openrouter, openai, google, anthropic, groq, mistral)',
                    default: false
                },
                action: {
                    type: 'object',
                    description: 'Content action to perform with LLM response',
                    properties: {
                        type: {
                            type: 'string',
                            enum: ['create', 'append', 'prepend', 'replace', 'findReplace']
                        },
                        targetPath: { type: 'string' },
                        position: { type: 'number' },
                        findText: { type: 'string' },
                        replaceAll: { type: 'boolean' },
                        caseSensitive: { type: 'boolean' },
                        wholeWord: { type: 'boolean' }
                    },
                    required: ['type', 'targetPath']
                }
            },
            required: ['prompt']
        };
        
        return this.getMergedSchema(customSchema);
    }

    /**
     * Get result schema for the mode
     */
    getResultSchema(): any {
        const commonSchema = getCommonResultSchema();
        
        return {
            ...commonSchema,
            properties: {
                ...commonSchema.properties,
                data: {
                    type: 'object',
                    properties: {
                        response: { type: 'string', description: 'The LLM response' },
                        model: { type: 'string', description: 'Model that was used' },
                        provider: { type: 'string', description: 'Provider that was used' },
                        agentUsed: { type: 'string', description: 'Agent that was used' },
                        usage: {
                            type: 'object',
                            properties: {
                                promptTokens: { type: 'number' },
                                completionTokens: { type: 'number' },
                                totalTokens: { type: 'number' }
                            }
                        },
                        cost: {
                            type: 'object',
                            properties: {
                                inputCost: { type: 'number' },
                                outputCost: { type: 'number' },
                                totalCost: { type: 'number' },
                                currency: { type: 'string' }
                            }
                        },
                        filesIncluded: {
                            type: 'array',
                            items: { type: 'string' }
                        },
                        actionPerformed: {
                            type: 'object',
                            properties: {
                                type: { type: 'string' },
                                targetPath: { type: 'string' },
                                success: { type: 'boolean' },
                                error: { type: 'string' }
                            }
                        }
                    },
                    required: ['response', 'model', 'provider', 'agentUsed']
                },
                recommendations: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            type: { type: 'string' },
                            message: { type: 'string' }
                        },
                        required: ['type', 'message']
                    },
                    description: 'Workspace-agent optimization recommendations'
                }
            }
        };
    }
}
