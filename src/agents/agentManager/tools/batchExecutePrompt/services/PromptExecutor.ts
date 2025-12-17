import { LLMService } from '../../../../../services/llm/core/LLMService';
import { CustomPromptStorageService } from '../../../services/CustomPromptStorageService';
import { BudgetValidator } from './BudgetValidator';
import { ContextBuilder } from './ContextBuilder';
import { 
  PromptConfig, 
  TextPromptConfig,
  PromptExecutionResult, 
  PromptExecutionParams,
  ExecutionContext 
} from '../types';
import { getErrorMessage } from '../../../../../utils/errorUtils';

/**
 * Service responsible for executing individual LLM prompts
 * Follows SRP by focusing only on prompt execution logic
 */
export class PromptExecutor {
  constructor(
    private llmService: LLMService,
    private budgetValidator: BudgetValidator,
    private contextBuilder: ContextBuilder,
    private promptStorage?: CustomPromptStorageService
  ) {}

  /**
   * Execute a single prompt with all necessary context and validation
   */
  async executePrompt(
    promptConfig: PromptConfig,
    executionContext: ExecutionContext,
    currentSequence: number,
    index: number = 0
  ): Promise<PromptExecutionResult> {
    try {
      // Add delay between concurrent requests to avoid overwhelming APIs
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, index * 100));
      }
      
      const startTime = performance.now();
      
      // Only handle text prompts - images are handled by RequestExecutor
      if (promptConfig.type !== 'text') {
        const executionTime = performance.now() - startTime;
        return {
          type: 'text',
          id: promptConfig.id,
          prompt: promptConfig.prompt,
          success: false,
          error: 'PromptExecutor only handles text prompts',
          executionTime,
          sequence: currentSequence,
          parallelGroup: promptConfig.parallelGroup
        };
      }

      const textConfig = promptConfig as TextPromptConfig;

      // Validate and determine provider and model
      const { provider, model, validationError } = await this.validateAndSelectProviderModel(textConfig);
      if (validationError) {
        const executionTime = performance.now() - startTime;
        return {
          type: 'text',
          id: textConfig.id,
          prompt: textConfig.prompt,
          success: false,
          error: validationError,
          provider: textConfig.provider,
          model: textConfig.model,
          agent: textConfig.agent || 'default',
          executionTime,
          sequence: currentSequence,
          parallelGroup: textConfig.parallelGroup
        };
      }

      // Resolve custom agent/prompt if specified
      const { systemPrompt, agentUsed } = await this.resolveCustomPrompt(textConfig.agent);
      
      // Build user prompt with context from previous results
      const userPrompt = this.contextBuilder.buildUserPromptWithContext(
        textConfig.prompt,
        textConfig,
        executionContext
      );
      
      // Build execution parameters with validated provider and model
      const executeParams: PromptExecutionParams = {
        systemPrompt,
        userPrompt,
        filepaths: textConfig.contextFiles,
        provider,
        model,
        workspace: textConfig.workspace,
        sessionId: executionContext.sessionId
      };
      
      // Check budget before executing
      await this.budgetValidator.validateBudget();
      
      // Execute the prompt
      const response = await this.llmService.executePrompt(executeParams);
      
      // Track usage
      if (response.cost && response.provider) {
        await this.budgetValidator.trackUsage(
          response.provider.toLowerCase(),
          response.cost.totalCost || 0
        );
      }
      
      const executionTime = performance.now() - startTime;
      
      return {
        type: 'text',
        id: textConfig.id,
        prompt: textConfig.prompt,
        success: true,
        response: response.response,
        provider: response.provider,
        model: response.model,
        agent: agentUsed,
        usage: response.usage,
        cost: response.cost,
        executionTime,
        filesIncluded: response.filesIncluded,
        sequence: currentSequence,
        parallelGroup: textConfig.parallelGroup
      };
      
    } catch (error) {
      return {
        type: 'text',
        id: promptConfig.id,
        prompt: promptConfig.prompt,
        success: false,
        error: getErrorMessage(error),
        provider: promptConfig.provider,
        model: promptConfig.model,
        agent: promptConfig.type === 'text' ? (promptConfig as TextPromptConfig).agent || 'default' : 'default',
        executionTime: 0,
        sequence: currentSequence,
        parallelGroup: promptConfig.parallelGroup
      };
    }
  }

  /**
   * Execute multiple prompts concurrently
   */
  async executeConcurrentPrompts(
    prompts: PromptConfig[],
    executionContext: ExecutionContext,
    currentSequence: number
  ): Promise<PromptExecutionResult[]> {
    const batchPromises = prompts.map((promptConfig, index) => 
      this.executePrompt(promptConfig, executionContext, currentSequence, index)
    );
    
    return await Promise.all(batchPromises);
  }

  /**
   * Validate and select provider and model for execution
   */
  private async validateAndSelectProviderModel(textConfig: TextPromptConfig): Promise<{
    provider?: string;
    model?: string;
    validationError?: string;
  }> {
    try {
      // Get available providers
      const availableProviders = this.llmService.getAvailableProviders();
      
      if (availableProviders.length === 0) {
        return {
          validationError: 'No LLM providers available. Please configure at least one provider with valid API keys in settings.'
        };
      }

      // Determine provider
      let selectedProvider = textConfig.provider;
      
      // If no provider specified, use the first available one
      if (!selectedProvider) {
        const defaultModel = this.llmService.getDefaultModel();
        selectedProvider = defaultModel.provider;
        
        // If default provider isn't available, use first available provider
        if (!availableProviders.includes(selectedProvider)) {
          selectedProvider = availableProviders[0];
        }
      }
      
      // Validate that selected provider is available
      if (!availableProviders.includes(selectedProvider)) {
        return {
          validationError: `Provider '${selectedProvider}' is not available. Available providers: ${availableProviders.join(', ')}. Please check your API key configuration.`
        };
      }

      // Get available models for the provider
      const availableModels = await this.llmService.getAvailableModels();
      const providerModels = availableModels.filter(m => m.provider === selectedProvider);
      
      if (providerModels.length === 0) {
        return {
          validationError: `No models available for provider '${selectedProvider}'.`
        };
      }

      // Determine model
      let selectedModel = textConfig.model;
      
      // If no model specified, use default or first available for provider
      if (!selectedModel) {
        const defaultModel = this.llmService.getDefaultModel();
        
        // If default provider matches, use default model
        if (defaultModel.provider === selectedProvider) {
          selectedModel = defaultModel.model;
        } else {
          // Use first available model for the provider
          selectedModel = providerModels[0].id;
        }
      }
      
      // Validate that selected model exists for the provider
      const modelExists = providerModels.some(m => m.id === selectedModel);
      if (!modelExists) {
        const availableModelNames = providerModels.map(m => m.id);
        return {
          validationError: `Model '${selectedModel}' is not available for provider '${selectedProvider}'. Available models: ${availableModelNames.join(', ')}`
        };
      }

      return {
        provider: selectedProvider,
        model: selectedModel
      };
      
    } catch (error) {
      return {
        validationError: `Failed to validate provider/model: ${getErrorMessage(error)}`
      };
    }
  }

  /**
   * Resolve custom agent/prompt configuration
   */
  private async resolveCustomPrompt(agentIdentifier?: string): Promise<{ systemPrompt: string; agentUsed: string }> {
    let systemPrompt = '';
    let agentUsed = 'default';

    if (agentIdentifier && this.promptStorage) {
      try {
        // Use unified lookup (tries ID first, then name)
        const customPrompt = await this.promptStorage.getPromptByNameOrId(agentIdentifier);
        if (customPrompt && customPrompt.isEnabled) {
          systemPrompt = customPrompt.prompt;
          agentUsed = customPrompt.name;
        }
      } catch (error) {
      }
    }

    return { systemPrompt, agentUsed };
  }
}