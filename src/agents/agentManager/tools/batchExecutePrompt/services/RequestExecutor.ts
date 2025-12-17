import { 
  PromptConfig, 
  TextPromptConfig, 
  ImagePromptConfig, 
  PromptExecutionResult,
  TextExecutionResult,
  ImageExecutionResult
} from '../types';
import { PromptExecutor } from './PromptExecutor';
import { ActionExecutor } from './ActionExecutor';

/**
 * Service responsible for executing different types of requests (text and image)
 * Coordinates between PromptExecutor and ActionExecutor for unified handling
 */
export class RequestExecutor {
  constructor(
    private promptExecutor: PromptExecutor,
    private actionExecutor: ActionExecutor
  ) {}

  /**
   * Execute a single request (text or image)
   */
  async executeRequest(
    config: PromptConfig,
    context: any,
    sessionId?: string
  ): Promise<PromptExecutionResult> {
    const startTime = performance.now();

    try {
      if (config.type === 'text') {
        return await this.executeTextRequest(config as TextPromptConfig, context, sessionId, startTime);
      } else if (config.type === 'image') {
        return await this.executeImageRequest(config as ImagePromptConfig, context, sessionId, startTime);
      } else {
        // TypeScript narrows this to never, but we keep it for runtime safety
        // Assert to the base type to access common properties
        const executionTime = performance.now() - startTime;
        const unknownConfig = config as TextPromptConfig | ImagePromptConfig;
        return {
          type: 'text', // Default fallback
          id: unknownConfig.id,
          prompt: unknownConfig.prompt,
          success: false,
          error: `Unknown request type: ${unknownConfig.type}`,
          executionTime,
          sequence: unknownConfig.sequence,
          parallelGroup: unknownConfig.parallelGroup
        } as TextExecutionResult;
      }
    } catch (error) {
      const executionTime = performance.now() - startTime;
      return {
        type: 'text', // Default fallback for errors
        id: config.id,
        prompt: config.prompt,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown execution error',
        executionTime,
        sequence: config.sequence,
        parallelGroup: config.parallelGroup
      } as TextExecutionResult;
    }
  }

  /**
   * Execute a text prompt request
   */
  private async executeTextRequest(
    config: TextPromptConfig,
    context: any,
    sessionId?: string,
    startTime?: number
  ): Promise<TextExecutionResult> {
    const actualStartTime = startTime || performance.now();

    try {
      // Execute the text prompt using the existing PromptExecutor
      const result = await this.promptExecutor.executePrompt(
        config, 
        context, 
        config.sequence || 0
      );
      
      const executionTime = performance.now() - actualStartTime;

      // Type guard to ensure we have a text result
      if (result.type === 'text') {
        return {
          type: 'text',
          id: config.id,
          prompt: config.prompt,
          success: result.success,
          response: result.response,
          provider: result.provider,
          model: result.model,
          agent: result.agent,
          error: result.error,
          executionTime,
          sequence: config.sequence,
          parallelGroup: config.parallelGroup,
          usage: result.usage,
          cost: result.cost,
          filesIncluded: result.filesIncluded,
          actionPerformed: result.actionPerformed
        };
      } else {
        // Handle unexpected result type
        return {
          type: 'text',
          id: config.id,
          prompt: config.prompt,
          success: false,
          error: 'Unexpected result type from text execution',
          executionTime,
          sequence: config.sequence,
          parallelGroup: config.parallelGroup
        };
      }
    } catch (error) {
      const executionTime = performance.now() - actualStartTime;
      return {
        type: 'text',
        id: config.id,
        prompt: config.prompt,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown text execution error',
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
    context: any,
    sessionId?: string,
    startTime?: number
  ): Promise<ImageExecutionResult> {
    const actualStartTime = startTime || performance.now();

    try {
      // Execute image generation using ActionExecutor
      const result = await this.actionExecutor.executeImageGenerationAction(
        config,
        sessionId,
        typeof context === 'string' ? context : JSON.stringify(context)
      );

      const executionTime = performance.now() - actualStartTime;

      if (result.success) {
        return {
          type: 'image',
          id: config.id,
          prompt: config.prompt,
          success: true,
          imagePath: result.imagePath,
          provider: config.provider,
          model: config.model || 'imagen-4',
          executionTime,
          sequence: config.sequence,
          parallelGroup: config.parallelGroup,
          // Note: Additional metadata like dimensions, fileSize, etc. would need to be
          // extracted from the image generation result if available
        };
      } else {
        return {
          type: 'image',
          id: config.id,
          prompt: config.prompt,
          success: false,
          error: result.error,
          provider: config.provider,
          model: config.model || 'imagen-4',
          executionTime,
          sequence: config.sequence,
          parallelGroup: config.parallelGroup
        };
      }
    } catch (error) {
      const executionTime = performance.now() - actualStartTime;
      return {
        type: 'image',
        id: config.id,
        prompt: config.prompt,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown image execution error',
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
    context: any,
    sessionId?: string
  ): Promise<PromptExecutionResult[]> {
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

      if (imageConfig.provider !== 'google') {
        return { valid: false, error: 'Only Google provider is currently supported for image generation' };
      }
    }

    return { valid: true };
  }
}