import { Plugin } from 'obsidian';
import { BaseMode } from '../../../baseMode';
import { getErrorMessage } from '../../../../utils/errorUtils';
import { createResult } from '../../../../utils/schemaUtils';
import { LLMProviderManager } from '../../../../services/llm/providers/ProviderManager';
import { LLMService } from '../../../../services/llm/core/LLMService';
import { AgentManager } from '../../../../services/AgentManager';
import { CustomPromptStorageService } from '../../services/CustomPromptStorageService';
import { UsageTracker } from '../../../../services/UsageTracker';

// Import refactored services and types
import {
  BatchExecutePromptParams,
  BatchExecutePromptResult,
  PromptConfig,
  ExecutionContext
} from './types';
import {
  BudgetValidator,
  ContextBuilder,
  PromptExecutor,
  RequestExecutor,
  SequenceManager,
  ResultProcessor,
  ActionExecutor
} from './services';
import { PromptParser } from './utils';
import { addRecommendations, Recommendation } from '../../../../utils/recommendationUtils';
import { NudgeHelpers } from '../../../../utils/nudgeHelpers';

/**
 * Refactored batch mode for executing multiple LLM prompts concurrently
 * Now follows SOLID principles with service composition
 * 
 * Responsibilities:
 * - Orchestrate prompt execution workflow
 * - Coordinate specialized services
 * - Handle high-level error management
 */
export class BatchExecutePromptMode extends BaseMode<BatchExecutePromptParams, BatchExecutePromptResult> {
  // Core services (injected)
  private llmService: LLMService | null = null;
  private providerManager: LLMProviderManager | null = null;
  private agentManager: AgentManager | null = null;
  private promptStorage: CustomPromptStorageService | null = null;
  private usageTracker: UsageTracker | null = null;

  // Specialized services (composition)
  private budgetValidator!: BudgetValidator;
  private contextBuilder!: ContextBuilder;
  private promptExecutor!: PromptExecutor;
  private requestExecutor!: RequestExecutor;
  private sequenceManager!: SequenceManager;
  private resultProcessor!: ResultProcessor;
  private actionExecutor!: ActionExecutor;
  
  // Utilities
  private promptParser!: PromptParser;

  constructor(
    plugin?: Plugin,
    llmService?: LLMService,
    providerManager?: LLMProviderManager,
    agentManager?: AgentManager,
    promptStorage?: CustomPromptStorageService
  ) {
    super(
      'batchExecutePrompt',
      'Batch Execute LLM Prompts',
      'Execute multiple LLM and image prompts concurrently across different providers. Supports context gathering, workspace integration, and result merging.',
      '1.0.0'
    );
    
    // Store injected dependencies
    this.llmService = llmService || null;
    this.providerManager = providerManager || null;
    this.agentManager = agentManager || null;
    this.promptStorage = promptStorage || null;

    // Initialize specialized services
    this.initializeServices();
  }

  /**
   * Wait for dependencies to be initialized
   * @param timeoutMs Maximum time to wait in milliseconds
   * @private
   */
  private async waitForDependencies(timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 100; // Check every 100ms
    
    while (Date.now() - startTime < timeoutMs) {
      if (this.llmService && this.providerManager && this.promptStorage) {
        return;
      }
      
      // Wait for the next check
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
  }

  /**
   * Initialize all specialized services following dependency injection patterns
   */
  private initializeServices(): void {
    // Initialize utilities
    this.promptParser = new PromptParser();

    // Initialize core services
    this.budgetValidator = new BudgetValidator(this.usageTracker || undefined);
    this.contextBuilder = new ContextBuilder();
    this.actionExecutor = new ActionExecutor(this.agentManager || undefined);

    // PromptExecutor requires LLM service, so we'll initialize it in execute() if needed
    // Same for SequenceManager and ResultProcessor
    this.resultProcessor = new ResultProcessor();
  }

  /**
   * Ensure request executor is initialized with all dependencies
   */
  private ensureRequestExecutor(): void {
    if (!this.promptExecutor && this.llmService) {
      this.promptExecutor = new PromptExecutor(
        this.llmService,
        this.budgetValidator,
        this.contextBuilder,
        this.promptStorage || undefined
      );
    }

    if (!this.requestExecutor && this.promptExecutor && this.actionExecutor) {
      this.requestExecutor = new RequestExecutor(
        this.promptExecutor,
        this.actionExecutor
      );

      this.sequenceManager = new SequenceManager(
        this.requestExecutor,
        this.contextBuilder
      );
    }
  }

  /**
   * Execute multiple LLM prompts with orchestrated workflow
   */
  async execute(params: BatchExecutePromptParams): Promise<BatchExecutePromptResult> {
    try {
      // Try to wait for dependencies if not available
      if (!this.llmService || !this.providerManager || !this.promptStorage) {
        await this.waitForDependencies(3000);
      }
      
      // Validate dependencies
      if (!this.llmService) {
        return createResult<BatchExecutePromptResult>(
          false, undefined, 'LLM Service not initialized',
          undefined, undefined, params.context.sessionId, params.context
        );
      }
      
      if (!this.providerManager) {
        return createResult<BatchExecutePromptResult>(
          false, undefined, 'LLM Provider Manager not initialized. Please ensure you have configured at least one LLM provider with valid API keys.',
          undefined, undefined, params.context.sessionId, params.context
        );
      }
      
      if (!this.promptStorage) {
        return createResult<BatchExecutePromptResult>(
          false, undefined, 'Prompt storage service not initialized',
          undefined, undefined, params.context.sessionId, params.context
        );
      }

      // Ensure specialized services are ready
      this.ensureRequestExecutor();
      if (!this.requestExecutor || !this.sequenceManager) {
        return createResult<BatchExecutePromptResult>(
          false, undefined, 'Failed to initialize execution services',
          undefined, undefined, params.context.sessionId, params.context
        );
      }

      // Validate parameters using utility
      const validation = this.promptParser.validateParameters(params);
      if (!validation.valid) {
        return createResult<BatchExecutePromptResult>(
          false, undefined, `Parameter validation failed: ${validation.errors.join(', ')}`,
          undefined, undefined, params.context.sessionId, params.context
        );
      }

      const startTime = performance.now();
      
      // Normalize prompt configurations
      const normalizedPrompts = this.promptParser.normalizePromptConfigs(params.prompts);
      
      // Initialize execution context
      const executionContext = this.contextBuilder.initializeExecutionContext(
        params.context.sessionId,
        params.context
      );
      
      // Execute prompts with sequence and parallel group support
      const results = await this.sequenceManager.executePromptsWithSequencing(
        normalizedPrompts,
        executionContext
      );
      
      // Process actions for results that have them
      await this.processResultActions(results, normalizedPrompts, params);
      
      const totalExecutionTime = performance.now() - startTime;
      
      // Process and format final results
      const processedResults = this.resultProcessor.processResults(
        results,
        params.mergeResponses || false,
        totalExecutionTime,
        params.prompts.length
      );
      
      const result = createResult<BatchExecutePromptResult>(
        processedResults.success,
        processedResults,
        processedResults.error,
        undefined, // workspaceContext
        params.context.sessionId,
        params.context
      );
      
      // Dynamic nudges based on operation count
      const nudges: Recommendation[] = [NudgeHelpers.suggestCaptureProgress()];
      const batchNudge = NudgeHelpers.checkBatchAgentOpportunity(processedResults.results?.length || 0);
      if (batchNudge) nudges.push(batchNudge);

      return addRecommendations(result, nudges);
      
    } catch (error) {
      console.error('Batch LLM prompt execution failed:', error);
      return createResult<BatchExecutePromptResult>(
        false,
        undefined,
        `Batch execution failed: ${getErrorMessage(error)}`,
        undefined, // workspaceContext
        params.context.sessionId,
        params.context
      );
    }
  }

  /**
   * Process content actions for results that specify them
   */
  private async processResultActions(
    results: any[],
    promptConfigs: PromptConfig[],
    params: BatchExecutePromptParams
  ): Promise<void> {
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const promptConfig = promptConfigs.find(p => p.id === result.id) || promptConfigs[i];
      
      // Only process actions for text results
      if (promptConfig?.type === 'text' && 'action' in promptConfig && promptConfig.action && 
          result.success && result.type === 'text' && result.response) {
        try {
          const actionResult = await this.actionExecutor.executeContentAction(
            promptConfig.action,
            result.response,
            params.context.sessionId,
            typeof params.context === 'string' ? params.context : JSON.stringify(params.context)
          );

          result.actionPerformed = {
            type: promptConfig.action.type,
            targetPath: promptConfig.action.targetPath,
            success: actionResult.success,
            error: actionResult.error
          };
        } catch (actionError) {
          result.actionPerformed = {
            type: promptConfig.action.type,
            targetPath: promptConfig.action.targetPath,
            success: false,
            error: actionError instanceof Error ? actionError.message : 'Unknown action error'
          };
        }
      }
    }
  }

  /**
   * Set the LLM service instance
   */
  setLLMService(llmService: LLMService): void {
    this.llmService = llmService;
  }

  /**
   * Set the usage tracker for LLM cost tracking
   */
  setUsageTracker(usageTracker: UsageTracker): void {
    this.usageTracker = usageTracker;
    this.budgetValidator = new BudgetValidator(usageTracker);
  }

  /**
   * Set the provider manager instance
   */
  setProviderManager(providerManager: LLMProviderManager): void {
    this.providerManager = providerManager;
    
    // Get LLM service from provider manager if we don't have one
    if (!this.llmService && providerManager) {
      this.llmService = providerManager.getLLMService();
    }
  }

  /**
   * Set the agent manager for action execution
   */
  setAgentManager(agentManager: AgentManager): void {
    this.agentManager = agentManager;
    this.actionExecutor = new ActionExecutor(agentManager);
  }

  /**
   * Set the prompt storage for custom agent support
   */
  setPromptStorage(promptStorage: CustomPromptStorageService): void {
    this.promptStorage = promptStorage;
  }

  /**
   * Get parameter schema for MCP tool definition
   */
  getParameterSchema(): any {
    // Get default from data.json settings
    const defaultModel = this.providerManager?.getSettings()?.defaultModel;
    
    const customSchema = {
      properties: {
        prompts: {
          type: 'array',
          description: 'Array of text and/or image generation requests to execute in batch',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['text', 'image'],
                description: 'Type of request: "text" for LLM prompts, "image" for AI image generation'
              },
              id: {
                type: 'string',
                description: 'Optional unique identifier for this request'
              },
              prompt: {
                type: 'string',
                description: 'Text prompt (for LLM) or image description (for image generation)',
                minLength: 1,
                maxLength: 32000
              },
              sequence: {
                type: 'integer',
                minimum: 0,
                description: 'Execution sequence (0, 1, 2, etc.). Requests in same sequence run in parallel'
              },
              parallelGroup: {
                type: 'string',
                description: 'Parallel group identifier within sequence. Different groups run sequentially'
              },
              includePreviousResults: {
                type: 'boolean',
                description: 'Include results from previous sequences as context'
              },
              contextFromSteps: {
                type: 'array',
                items: { type: 'string' },
                description: 'Specific request IDs to include as context'
              },
              // Text-specific properties
              provider: {
                type: 'string',
                description: `LLM provider (defaults to: ${defaultModel?.provider || 'not configured'}). For images, use "google". Use listModels to see available providers.`,
                default: defaultModel?.provider
              },
              model: {
                type: 'string',
                description: `Model name (defaults to: ${defaultModel?.model || 'not configured'}). Use listModels to see available models.`,
                default: defaultModel?.model
              },
              contextFiles: {
                type: 'array',
                items: { type: 'string' },
                description: 'File paths to include as context (text requests only)'
              },
              workspace: {
                type: 'string',
                description: 'Workspace name for context gathering (text requests only)'
              },
              action: {
                type: 'object',
                description: 'Content action to perform with LLM response (text requests only)',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['create', 'append', 'prepend', 'replace', 'findReplace']
                  },
                  targetPath: { type: 'string' },
                  findText: { type: 'string' },
                  replaceAll: { type: 'boolean' },
                  caseSensitive: { type: 'boolean' },
                  wholeWord: { type: 'boolean' }
                },
                required: ['type', 'targetPath']
              },
              agent: {
                type: 'string',
                description: 'Custom agent/prompt name to use (text requests only)'
              },
              // Image-specific properties
              savePath: {
                type: 'string',
                description: 'Vault-relative path to save generated image (image requests only)',
                pattern: '^[^/].*\\.(png|jpg|jpeg|webp)$'
              },
              aspectRatio: {
                type: 'string',
                description: 'Image aspect ratio (image requests only)',
                enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
                default: '1:1'
              }
            },
            required: ['type', 'prompt', 'provider', 'model'],
            allOf: [
              {
                if: { properties: { type: { const: 'image' } } },
                then: {
                  required: ['savePath'],
                  properties: {
                    provider: { const: 'google' }
                  }
                }
              }
            ]
          }
        },
        mergeResponses: {
          type: 'boolean',
          description: 'Whether to merge all responses into a single result',
          default: false
        }
      },
      required: ['prompts']
    };
    
    return this.getMergedSchema(customSchema);
  }

  /**
   * Get result schema for MCP tool definition
   */
  getResultSchema(): any {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the batch execution succeeded overall'
        },
        message: {
          type: 'string',
          description: 'Status message about the batch execution'
        },
        data: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              description: 'Individual results from each request',
              items: {
                oneOf: [
                  {
                    type: 'object',
                    description: 'Text prompt result',
                    properties: {
                      type: { const: 'text' },
                      id: { type: 'string' },
                      prompt: { type: 'string' },
                      success: { type: 'boolean' },
                      response: { type: 'string' },
                      provider: { type: 'string' },
                      model: { type: 'string' },
                      agent: { type: 'string' },
                      error: { type: 'string' },
                      executionTime: { type: 'number' },
                      sequence: { type: 'number' },
                      parallelGroup: { type: 'string' },
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
                    required: ['type', 'success']
                  },
                  {
                    type: 'object',
                    description: 'Image generation result',
                    properties: {
                      type: { const: 'image' },
                      id: { type: 'string' },
                      prompt: { type: 'string' },
                      success: { type: 'boolean' },
                      imagePath: { type: 'string' },
                      revisedPrompt: { type: 'string' },
                      provider: { type: 'string' },
                      model: { type: 'string' },
                      error: { type: 'string' },
                      executionTime: { type: 'number' },
                      sequence: { type: 'number' },
                      parallelGroup: { type: 'string' },
                      dimensions: {
                        type: 'object',
                        properties: {
                          width: { type: 'number' },
                          height: { type: 'number' }
                        }
                      },
                      fileSize: { type: 'number' },
                      format: { type: 'string' },
                      usage: {
                        type: 'object',
                        properties: {
                          imagesGenerated: { type: 'number' },
                          resolution: { type: 'string' },
                          model: { type: 'string' },
                          provider: { type: 'string' }
                        }
                      },
                      cost: {
                        type: 'object',
                        properties: {
                          inputCost: { type: 'number' },
                          outputCost: { type: 'number' },
                          totalCost: { type: 'number' },
                          currency: { type: 'string' },
                          ratePerImage: { type: 'number' }
                        }
                      },
                      metadata: {
                        type: 'object',
                        description: 'Additional image metadata'
                      }
                    },
                    required: ['type', 'success']
                  }
                ]
              }
            },
            mergedResponse: {
              type: 'object',
              description: 'Merged response when mergeResponses is true',
              properties: {
                totalPrompts: { type: 'number' },
                successfulPrompts: { type: 'number' },
                mergedContent: { type: 'string' },
                providersUsed: {
                  type: 'array',
                  items: { type: 'string' }
                }
              }
            },
            executionStats: {
              type: 'object',
              properties: {
                totalExecutionTimeMS: { type: 'number' },
                promptsExecuted: { type: 'number' },
                promptsFailed: { type: 'number' },
                avgExecutionTimeMS: { type: 'number' },
                totalTokens: { type: 'number' },
                totalCost: { type: 'number' }
              }
            }
          },
          required: ['results']
        }
      },
      required: ['success']
    };
  }
}