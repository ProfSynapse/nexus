import { AgentManager } from '../../../../../services/AgentManager';
import { ContentAction, ImagePromptConfig } from '../types';
import { CommonResult } from '../../../../../types';

/**
 * Type guard to verify a value conforms to CommonResult interface
 * This allows safe narrowing from unknown returns of executeAgentTool
 */
function isCommonResult(value: unknown): value is CommonResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof (value as CommonResult).success === 'boolean'
  );
}

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
      const actionParams: Record<string, unknown> = {
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
    actionParams: Record<string, unknown>,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    actionParams.path = action.targetPath;
    actionParams.overwrite = false;
    const createResult = await this.agentManager!.executeAgentTool('contentManager', 'write', actionParams);
    if (!isCommonResult(createResult)) {
      return { success: false, error: 'Invalid response from write tool' };
    }
    return { success: createResult.success, error: createResult.error };
  }

  /**
   * Execute append content action
   */
  private async executeAppendAction(
    actionParams: Record<string, unknown>,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    actionParams.path = action.targetPath;
    actionParams.startLine = -1;
    const appendResult = await this.agentManager!.executeAgentTool('contentManager', 'update', actionParams);
    if (!isCommonResult(appendResult)) {
      return { success: false, error: 'Invalid response from update tool' };
    }
    return { success: appendResult.success, error: appendResult.error };
  }

  /**
   * Execute prepend content action
   */
  private async executePrependAction(
    actionParams: Record<string, unknown>,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    actionParams.path = action.targetPath;
    actionParams.startLine = 1;
    const prependResult = await this.agentManager!.executeAgentTool('contentManager', 'update', actionParams);
    if (!isCommonResult(prependResult)) {
      return { success: false, error: 'Invalid response from update tool' };
    }
    return { success: prependResult.success, error: prependResult.error };
  }

  /**
   * Execute replace content action
   */
  private async executeReplaceAction(
    actionParams: Record<string, unknown>,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    actionParams.path = action.targetPath;
    let replaceResult: unknown;

    if (action.position !== undefined) {
      actionParams.startLine = action.position;
      actionParams.endLine = action.position;
      replaceResult = await this.agentManager!.executeAgentTool('contentManager', 'update', actionParams);
    } else {
      actionParams.overwrite = true;
      replaceResult = await this.agentManager!.executeAgentTool('contentManager', 'write', actionParams);
    }

    if (!isCommonResult(replaceResult)) {
      return { success: false, error: 'Invalid response from replace tool' };
    }
    return { success: replaceResult.success, error: replaceResult.error };
  }

  /**
   * Execute find and replace content action
   */
  private async executeFindReplaceAction(
    actionParams: Record<string, unknown>,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    if (!action.findText) {
      return { success: false, error: 'findText is required for findReplace action' };
    }

    const targetPath = action.targetPath;
    const replaceText = actionParams.content as string;
    const replaceAll = action.replaceAll ?? false;
    const caseSensitive = action.caseSensitive ?? true;
    const wholeWord = action.wholeWord ?? false;

    // Step 1: Read the file
    const readResult = await this.agentManager!.executeAgentTool('contentManager', 'read', {
      path: targetPath,
      startLine: 1,
      sessionId: actionParams.sessionId,
      context: actionParams.context
    });

    if (!isCommonResult(readResult) || !readResult.success) {
      return { success: false, error: 'Failed to read file for findReplace' };
    }

    const fileContent = (readResult.data as { content: string })?.content;
    if (fileContent === undefined) {
      return { success: false, error: 'Could not read file content for findReplace' };
    }

    // Step 2: Perform find and replace on the text
    let modifiedContent: string;
    const escapedFind = action.findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = wholeWord ? `\\b${escapedFind}\\b` : escapedFind;
    const flags = (replaceAll ? 'g' : '') + (caseSensitive ? '' : 'i');
    const regex = new RegExp(pattern, flags);

    if (!regex.test(fileContent)) {
      return { success: false, error: `findText "${action.findText}" not found in file` };
    }
    regex.lastIndex = 0;
    modifiedContent = fileContent.replace(regex, replaceText);

    // Step 3: Write modified content back
    const writeResult = await this.agentManager!.executeAgentTool('contentManager', 'write', {
      path: targetPath,
      content: modifiedContent,
      overwrite: true,
      sessionId: actionParams.sessionId,
      context: actionParams.context
    });

    if (!isCommonResult(writeResult)) {
      return { success: false, error: 'Invalid response from write tool after findReplace' };
    }
    return { success: writeResult.success, error: writeResult.error };
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
      const imageParams: Record<string, unknown> = {
        prompt: imageConfig.prompt,
        provider: imageConfig.provider,
        model: imageConfig.model,
        aspectRatio: imageConfig.aspectRatio,
        savePath: imageConfig.savePath,
        referenceImages: imageConfig.referenceImages,
        sessionId: sessionId || '',
        context: context || ''
      };

      const imageResult = await this.agentManager.executeAgentTool('promptManager', 'generateImage', imageParams);

      if (!isCommonResult(imageResult)) {
        return { success: false, error: 'Invalid response from generateImage tool' };
      }

      const data = imageResult.data as { imagePath?: string } | undefined;
      if (imageResult.success && data?.imagePath) {
        return {
          success: true,
          imagePath: data.imagePath
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