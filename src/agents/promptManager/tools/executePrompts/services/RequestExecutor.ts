import {
  PromptConfig,
  TextPromptConfig,
  ImagePromptConfig,
  InternalExecutionResult
} from '../types';
import { PromptExecutor } from './PromptExecutor';
import { ActionExecutor } from './ActionExecutor';
import { ExecutionErrorService } from './ExecutionErrorService';

/**
 * Service responsible for executing different types of requests (text and image)
 * Coordinates between PromptExecutor and ActionExecutor for unified handling
 */
export class RequestExecutor {
  constructor(
    private promptExecutor: PromptExecutor,
    private actionExecutor: ActionExecutor,
    private executionErrorService: ExecutionErrorService
  ) {}

  /**
   * Execute a single request (text or image)
   */
  async executeRequest(
    config: PromptConfig,
    context: unknown,
    sessionId?: string
  ): Promise<InternalExecutionResult> {
    const startTime = performance.now();

    try {
      if (config.type === 'text') {
        return await this.executeTextRequest(config as TextPromptConfig, context, sessionId, startTime);
      } else if (config.type === 'image') {
        return await this.executeImageRequest(config as ImagePromptConfig, context, sessionId, startTime);
      } else {
        const executionTime = performance.now() - startTime;
        const unknownConfig = config as TextPromptConfig | ImagePromptConfig;
        return {
          type: 'text',
          id: unknownConfig.id,
          prompt: unknownConfig.prompt,
          success: false,
          error: `Unknown request type: ${unknownConfig.type}`,
          executionTime,
          sequence: unknownConfig.sequence,
          parallelGroup: unknownConfig.parallelGroup
        };
      }
    } catch (error) {
      const executionTime = performance.now() - startTime;
      return {
        type: 'text',
        id: config.id,
        prompt: config.prompt,
        success: false,
        error: this.executionErrorService.normalizeExecutionError(error, {
          provider: config.provider,
          model: config.model
        }),
        executionTime,
        sequence: config.sequence,
        parallelGroup: config.parallelGroup
      };
    }
  }

  /**
   * Execute a text prompt request
   */
  private async executeTextRequest(
    config: TextPromptConfig,
    context: unknown,
    _sessionId?: string,
    startTime?: number
  ): Promise<InternalExecutionResult> {
    const actualStartTime = startTime || performance.now();

    try {
      // Execute the text prompt using the existing PromptExecutor
      const result = await this.promptExecutor.executePrompt(
        config,
        context as import('../types').ExecutionContext,
        config.sequence || 0
      );

      const executionTime = performance.now() - actualStartTime;
      return { ...result, executionTime };
    } catch (error) {
      const executionTime = performance.now() - actualStartTime;
      return {
        type: 'text',
        id: config.id,
        prompt: config.prompt,
        success: false,
        error: this.executionErrorService.normalizeExecutionError(error, {
          provider: config.provider,
          model: config.model
        }),
        executionTime,
        sequence: config.sequence,
        parallelGroup: config.parallelGroup
      };
    }
  }

  /**
   * Execute an image generation request
   */
  private async executeImageRequest(
    config: ImagePromptConfig,
    context: unknown,
    sessionId?: string,
    startTime?: number
  ): Promise<InternalExecutionResult> {
    const actualStartTime = startTime || performance.now();

    try {
      // Execute image generation using ActionExecutor
      const result = await this.actionExecutor.executeImageGenerationAction(
        config,
        sessionId,
        typeof context === 'string' ? context : JSON.stringify(context)
      );

      const executionTime = performance.now() - actualStartTime;

      return {
        type: 'image',
        id: config.id,
        prompt: config.prompt,
        success: result.success,
        imagePath: result.imagePath,
        error: result.error,
        provider: config.provider,
        model: config.model || 'imagen-4',
        executionTime,
        sequence: config.sequence,
        parallelGroup: config.parallelGroup
      };
    } catch (error) {
      const executionTime = performance.now() - actualStartTime;
      return {
        type: 'image',
        id: config.id,
        prompt: config.prompt,
        success: false,
        error: this.executionErrorService.normalizeExecutionError(error, {
          provider: config.provider,
          model: config.model
        }),
        provider: config.provider,
        model: config.model || 'imagen-4',
        executionTime,
        sequence: config.sequence,
        parallelGroup: config.parallelGroup
      };
    }
  }

  /**
   * Execute multiple requests in parallel
   */
  async executeRequestsInParallel(
    configs: PromptConfig[],
    context: unknown,
    sessionId?: string
  ): Promise<InternalExecutionResult[]> {
    const promises = configs.map(config =>
      this.executeRequest(config, context, sessionId)
    );

    return await Promise.all(promises);
  }

  /**
   * Validate a request configuration
   */
  validateRequest(config: PromptConfig): { valid: boolean; error?: string } {
    if (!config.type) {
      return { valid: false, error: 'Request type is required' };
    }

    if (!config.prompt || config.prompt.trim().length === 0) {
      return { valid: false, error: 'Prompt is required' };
    }

    if (config.type === 'image') {
      const imageConfig = config as ImagePromptConfig;
      
      if (!imageConfig.savePath || imageConfig.savePath.trim().length === 0) {
        return { valid: false, error: 'Save path is required for image generation' };
      }

      if (imageConfig.savePath.includes('..') || imageConfig.savePath.startsWith('/')) {
        return { valid: false, error: 'Save path must be relative to vault root' };
      }

      // If provider is explicitly specified and it's not 'google', error
      // If provider is not specified, that's OK - it will default to 'google' in the image generation tool
      if (imageConfig.provider && imageConfig.provider !== 'google') {
        return { valid: false, error: 'Only Google provider is currently supported for image generation' };
      }
    }

    return { valid: true };
  }
}
