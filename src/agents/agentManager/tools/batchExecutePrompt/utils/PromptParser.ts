import { PromptConfig, BatchExecutePromptParams, BatchRequest, TextPromptRequest, ImageGenerationRequest } from '../types';

/**
 * Utility for parsing and validating prompt configurations
 * Follows SRP by focusing only on prompt parsing logic
 */
export class PromptParser {

  /**
   * Validate batch execution parameters
   */
  validateParameters(params: BatchExecutePromptParams): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!params.prompts || params.prompts.length === 0) {
      errors.push('At least one prompt is required');
    }

    if (params.prompts && params.prompts.length > 100) {
      errors.push('Maximum of 100 prompts allowed per batch');
    }

    // Validate individual prompts
    if (params.prompts) {
      params.prompts.forEach((prompt, index) => {
        const promptErrors = this.validatePromptConfig(prompt, index);
        errors.push(...promptErrors);
      });
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate individual request configuration (text or image)
   */
  validatePromptConfig(requestConfig: any, index: number): string[] {
    const errors: string[] = [];
    const prefix = `Request ${index + 1}`;
    const requestType = requestConfig.type || 'text'; // Default to text for backward compatibility

    if (!requestConfig.prompt || typeof requestConfig.prompt !== 'string') {
      errors.push(`${prefix}: prompt text is required and must be a string`);
    }

    if (requestConfig.prompt && requestConfig.prompt.length > 32000) {
      errors.push(`${prefix}: prompt text cannot exceed 32,000 characters`);
    }

    // Type-specific validation
    if (requestType === 'image') {
      const imageConfig = requestConfig as ImageGenerationRequest;
      
      if (!imageConfig.savePath || typeof imageConfig.savePath !== 'string') {
        errors.push(`${prefix}: savePath is required for image generation`);
      }

      if (imageConfig.savePath && (imageConfig.savePath.includes('..') || imageConfig.savePath.startsWith('/'))) {
        errors.push(`${prefix}: savePath must be relative to vault root`);
      }

      if (!imageConfig.provider || imageConfig.provider !== 'google') {
        errors.push(`${prefix}: only 'google' provider is currently supported for image generation`);
      }

      if (imageConfig.model && !['imagen-4', 'imagen-4-ultra'].includes(imageConfig.model)) {
        errors.push(`${prefix}: invalid model for image generation. Supported: imagen-4, imagen-4-ultra`);
      }

    }

    if (requestConfig.sequence !== undefined && (typeof requestConfig.sequence !== 'number' || requestConfig.sequence < 0)) {
      errors.push(`${prefix}: sequence must be a non-negative number`);
    }

    if (requestConfig.contextFiles && !Array.isArray(requestConfig.contextFiles)) {
      errors.push(`${prefix}: contextFiles must be an array`);
    }

    if (requestConfig.contextFromSteps && !Array.isArray(requestConfig.contextFromSteps)) {
      errors.push(`${prefix}: contextFromSteps must be an array`);
    }

    // Only validate actions for text requests (images don't have actions)
    if (requestType === 'text' && requestConfig.action) {
      const actionErrors = this.validateActionConfig(requestConfig.action, prefix);
      errors.push(...actionErrors);
    }

    return errors;
  }

  /**
   * Validate action configuration
   */
  validateActionConfig(action: any, prefix: string): string[] {
    const errors: string[] = [];

    if (!action.type) {
      errors.push(`${prefix}: action.type is required`);
    }

    if (!action.targetPath) {
      errors.push(`${prefix}: action.targetPath is required`);
    }

    const validActionTypes = ['create', 'append', 'prepend', 'replace', 'findReplace'];
    if (action.type && !validActionTypes.includes(action.type)) {
      errors.push(`${prefix}: action.type must be one of: ${validActionTypes.join(', ')}`);
    }

    if (action.type === 'findReplace' && !action.findText) {
      errors.push(`${prefix}: action.findText is required for findReplace action`);
    }

    if (action.position !== undefined && (typeof action.position !== 'number' || action.position < 0)) {
      errors.push(`${prefix}: action.position must be a non-negative number`);
    }

    return errors;
  }

  /**
   * Normalize request configurations (text and image)
   */
  normalizePromptConfigs(requests: any[]): PromptConfig[] {
    return requests.map((request, index) => {
      const requestType = request.type || 'text'; // Default to text for backward compatibility
      const baseConfig = {
        id: request.id || `request_${index + 1}`,
        sequence: request.sequence || 0,
        parallelGroup: request.parallelGroup || 'default',
        includePreviousResults: request.includePreviousResults || false,
        contextFromSteps: request.contextFromSteps || [],
        prompt: request.prompt
      };

      if (requestType === 'image') {
        return {
          type: 'image',
          ...baseConfig,
          provider: request.provider || 'google',
          model: request.model || 'imagen-4',
          aspectRatio: request.aspectRatio,
          size: request.size,
          quality: request.quality,
          safety: request.safety,
          savePath: request.savePath,
          format: request.format,
          background: request.background
        } as PromptConfig;
      } else {
        return {
          type: 'text',
          ...baseConfig,
          provider: request.provider,
          model: request.model,
          contextFiles: request.contextFiles || [],
          workspace: request.workspace,
          action: request.action,
          agent: request.agent
        } as PromptConfig;
      }
    });
  }

  /**
   * Extract unique sequences from prompts
   */
  extractSequences(prompts: PromptConfig[]): number[] {
    const sequences = new Set(prompts.map(p => p.sequence || 0));
    return Array.from(sequences).sort((a, b) => a - b);
  }

  /**
   * Extract unique parallel groups from prompts
   */
  extractParallelGroups(prompts: PromptConfig[]): string[] {
    const groups = new Set(prompts.map(p => p.parallelGroup || 'default'));
    return Array.from(groups).sort();
  }

  /**
   * Get execution plan summary
   */
  getExecutionPlan(prompts: PromptConfig[]): {
    totalPrompts: number;
    sequences: number[];
    parallelGroups: string[];
    estimatedDuration: string;
  } {
    const sequences = this.extractSequences(prompts);
    const parallelGroups = this.extractParallelGroups(prompts);
    
    // Rough estimation based on typical LLM response times
    const avgPromptTime = 5; // seconds
    const maxConcurrency = Math.max(...parallelGroups.map(group => 
      prompts.filter(p => (p.parallelGroup || 'default') === group).length
    ));
    
    const estimatedSeconds = sequences.length * avgPromptTime * Math.ceil(prompts.length / maxConcurrency);
    const estimatedDuration = this.formatDuration(estimatedSeconds);

    return {
      totalPrompts: prompts.length,
      sequences,
      parallelGroups,
      estimatedDuration
    };
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}s`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
  }
}