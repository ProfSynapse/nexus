import { AgentManager } from '../../../../../services/AgentManager';
import { ContentAction, ImagePromptConfig } from '../types';

/**
 * Service responsible for executing content actions with LLM responses
 * Follows SRP by focusing only on action execution logic
 */
export class ActionExecutor {
  constructor(private agentManager?: AgentManager) {}

  /**
   * Execute a ContentManager action with the LLM response
   */
  async executeContentAction(
    action: ContentAction,
    content: string,
    sessionId?: string,
    context?: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.agentManager) {
      return { success: false, error: 'Agent manager not available' };
    }

    try {
      const actionParams: any = {
        sessionId: sessionId || '',
        context: context || '',
        content
      };

      switch (action.type) {
        case 'create':
          return await this.executeCreateAction(actionParams, action);
        case 'append':
          return await this.executeAppendAction(actionParams, action);
        case 'prepend':
          return await this.executePrependAction(actionParams, action);
        case 'replace':
          return await this.executeReplaceAction(actionParams, action);
        case 'findReplace':
          return await this.executeFindReplaceAction(actionParams, action);
        default:
          return { success: false, error: `Unknown action type: ${action.type}` };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error executing action'
      };
    }
  }

  /**
   * Execute create content action
   */
  private async executeCreateAction(
    actionParams: any,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    actionParams.filePath = action.targetPath;
    const createResult = await this.agentManager!.executeAgentMode('contentManager', 'createContent', actionParams);
    return { success: createResult.success, error: createResult.error };
  }

  /**
   * Execute append content action
   */
  private async executeAppendAction(
    actionParams: any,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    actionParams.filePath = action.targetPath;
    const appendResult = await this.agentManager!.executeAgentMode('contentManager', 'appendContent', actionParams);
    return { success: appendResult.success, error: appendResult.error };
  }

  /**
   * Execute prepend content action
   */
  private async executePrependAction(
    actionParams: any,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    actionParams.filePath = action.targetPath;
    const prependResult = await this.agentManager!.executeAgentMode('contentManager', 'prependContent', actionParams);
    return { success: prependResult.success, error: prependResult.error };
  }

  /**
   * Execute replace content action
   */
  private async executeReplaceAction(
    actionParams: any,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    actionParams.filePath = action.targetPath;
    let replaceResult;
    
    if (action.position !== undefined) {
      actionParams.line = action.position;
      replaceResult = await this.agentManager!.executeAgentMode('contentManager', 'replaceByLine', actionParams);
    } else {
      replaceResult = await this.agentManager!.executeAgentMode('contentManager', 'replaceContent', actionParams);
    }
    
    return { success: replaceResult.success, error: replaceResult.error };
  }

  /**
   * Execute find and replace content action
   */
  private async executeFindReplaceAction(
    actionParams: any,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    if (!action.findText) {
      return { success: false, error: 'findText is required for findReplace action' };
    }
    
    actionParams.filePath = action.targetPath;
    actionParams.findText = action.findText;
    actionParams.replaceText = actionParams.content; // LLM response becomes the replacement text
    actionParams.replaceAll = action.replaceAll ?? false;
    actionParams.caseSensitive = action.caseSensitive ?? true;
    actionParams.wholeWord = action.wholeWord ?? false;
    
    const findReplaceResult = await this.agentManager!.executeAgentMode('contentManager', 'findReplaceContent', actionParams);
    return { success: findReplaceResult.success, error: findReplaceResult.error };
  }

  /**
   * Validate action configuration
   */
  validateAction(action: ContentAction): { valid: boolean; error?: string } {
    if (!action.type) {
      return { valid: false, error: 'Action type is required' };
    }

    if (!action.targetPath) {
      return { valid: false, error: 'Target path is required' };
    }

    if (action.type === 'findReplace' && !action.findText) {
      return { valid: false, error: 'findText is required for findReplace action' };
    }

    if (action.type === 'replace' && action.position !== undefined && action.position < 0) {
      return { valid: false, error: 'Position must be non-negative for replace action' };
    }

    return { valid: true };
  }

  /**
   * Execute image generation action
   */
  async executeImageGenerationAction(
    imageConfig: ImagePromptConfig,
    sessionId?: string,
    context?: string
  ): Promise<{ success: boolean; error?: string; imagePath?: string }> {
    if (!this.agentManager) {
      return { success: false, error: 'Agent manager not available' };
    }

    try {
      console.log(`[ActionExecutor] Image config aspectRatio:`, imageConfig.aspectRatio);
      const imageParams = {
        prompt: imageConfig.prompt,
        provider: imageConfig.provider,
        model: imageConfig.model,
        aspectRatio: imageConfig.aspectRatio,
        savePath: imageConfig.savePath,
        sessionId: sessionId || '',
        context: context || ''
      };
      console.log(`[ActionExecutor] Image params aspectRatio:`, imageParams.aspectRatio);

      const imageResult = await this.agentManager.executeAgentMode('agentManager', 'generateImage', imageParams);
      
      if (imageResult.success && imageResult.data?.imagePath) {
        return { 
          success: true, 
          imagePath: imageResult.data.imagePath 
        };
      } else {
        return { 
          success: false, 
          error: imageResult.error || 'Image generation failed without specific error' 
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error executing image generation'
      };
    }
  }

  /**
   * Get supported action types
   */
  getSupportedActionTypes(): string[] {
    return ['create', 'append', 'prepend', 'replace', 'findReplace'];
  }

  /**
   * Get supported request types
   */
  getSupportedRequestTypes(): string[] {
    return ['text', 'image'];
  }
}