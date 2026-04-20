import { App } from 'obsidian';
import { AgentManager } from '../../../../../services/AgentManager';
import { ContentAction, ImagePromptConfig } from '../types';
import { CommonResult } from '../../../../../types';
import { ContentOperations } from '../../../../contentManager/utils/ContentOperations';

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
  constructor(private agentManager?: AgentManager, private appGetter?: () => App | null | undefined) {}

  private getReplaceRange(action: ContentAction): { startLine: number; endLine: number } | null {
    if (typeof action.position === 'number') {
      return {
        startLine: action.position,
        endLine: action.position
      };
    }

    if (typeof action.startLine === 'number' && typeof action.endLine === 'number') {
      return {
        startLine: action.startLine,
        endLine: action.endLine
      };
    }

    return null;
  }

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

    const validation = this.validateAction(action);
    if (!validation.valid) {
      return { success: false, error: validation.error };
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
          return { success: false, error: 'Unknown action type' };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error executing action'
      };
    }
  }

  /**
   * Execute create content action — uses ContentManager 'write' with overwrite: false
   */
  private async executeCreateAction(
    actionParams: Record<string, unknown>,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    const agentManager = this.agentManager;
    if (!agentManager) {
      return { success: false, error: 'Agent manager not available' };
    }

    actionParams.path = action.targetPath;
    actionParams.overwrite = false;
    const createResult = await agentManager.executeAgentTool('contentManager', 'write', actionParams);
    if (!isCommonResult(createResult)) {
      return { success: false, error: 'Invalid response from write tool' };
    }
    return { success: createResult.success, error: createResult.error };
  }

  /**
   * Execute append content action — uses ContentManager 'insert' with startLine: -1
   */
  private async executeAppendAction(
    actionParams: Record<string, unknown>,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    const agentManager = this.agentManager;
    if (!agentManager) {
      return { success: false, error: 'Agent manager not available' };
    }

    const appendResult = await agentManager.executeAgentTool('contentManager', 'insert', {
      ...actionParams,
      path: action.targetPath,
      startLine: -1
    });
    if (!isCommonResult(appendResult)) {
      return { success: false, error: 'Invalid response from insert tool' };
    }
    return { success: appendResult.success, error: appendResult.error };
  }

  /**
   * Execute prepend content action — uses ContentManager 'insert' with startLine: 1
   */
  private async executePrependAction(
    actionParams: Record<string, unknown>,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    const agentManager = this.agentManager;
    if (!agentManager) {
      return { success: false, error: 'Agent manager not available' };
    }

    const prependResult = await agentManager.executeAgentTool('contentManager', 'insert', {
      ...actionParams,
      path: action.targetPath,
      startLine: 1
    });
    if (!isCommonResult(prependResult)) {
      return { success: false, error: 'Invalid response from insert tool' };
    }
    return { success: prependResult.success, error: prependResult.error };
  }

  /**
   * Execute replace content action — line-range uses 'replace', full-file uses 'write'
   */
  private async executeReplaceAction(
    actionParams: Record<string, unknown>,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    const agentManager = this.agentManager;
    if (!agentManager) {
      return { success: false, error: 'Agent manager not available' };
    }

    let replaceResult: unknown;

    const replaceRange = this.getReplaceRange(action);
    if (replaceRange && typeof action.oldContent === 'string') {
      replaceResult = await agentManager.executeAgentTool('contentManager', 'replace', {
        path: action.targetPath,
        oldContent: action.oldContent,
        newContent: actionParams.content,
        startLine: replaceRange.startLine,
        endLine: replaceRange.endLine,
        sessionId: actionParams.sessionId,
        context: actionParams.context
      });
    } else {
      replaceResult = await agentManager.executeAgentTool('contentManager', 'write', {
        ...actionParams,
        path: action.targetPath,
        overwrite: true
      });
    }

    if (!isCommonResult(replaceResult)) {
      return { success: false, error: 'Invalid response from replace tool' };
    }
    return { success: replaceResult.success, error: replaceResult.error };
  }

  /**
   * Execute find and replace content action.
   * Uses ContentOperations.readContent() for raw file access (no line numbers),
   * applies regex replacement, then writes back via ContentManager 'write' tool.
   */
  private async executeFindReplaceAction(
    actionParams: Record<string, unknown>,
    action: ContentAction
  ): Promise<{ success: boolean; error?: string }> {
    if (!action.findText) {
      return { success: false, error: 'findText is required for findReplace action' };
    }

    const app = this.appGetter?.();
    if (!app) {
      return { success: false, error: 'App instance not available for findReplace' };
    }

    const targetPath = action.targetPath;
    const replaceText = actionParams.content as string;
    const replaceAll = action.replaceAll ?? false;
    const caseSensitive = action.caseSensitive ?? true;
    const wholeWord = action.wholeWord ?? false;

    // Step 1: Read raw file content via ContentOperations (no line numbers)
    let fileContent: string;
    try {
      fileContent = await ContentOperations.readContent(app, targetPath);
    } catch (error) {
      return { success: false, error: `Failed to read file for findReplace: ${error instanceof Error ? error.message : String(error)}` };
    }

    // Step 2: Build regex with proper escaping
    const escapedFind = action.findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = wholeWord ? `\\b${escapedFind}\\b` : escapedFind;
    const flags = (replaceAll ? 'g' : '') + (caseSensitive ? '' : 'i');
    const regex = new RegExp(pattern, flags);

    if (!regex.test(fileContent)) {
      return { success: false, error: `findText "${action.findText}" not found in file` };
    }
    regex.lastIndex = 0;
    const modifiedContent = fileContent.replace(regex, replaceText);

    // Step 3: Write modified content back via ContentManager 'write' tool
    const agentManager = this.agentManager;
    if (!agentManager) {
      return { success: false, error: 'Agent manager not available' };
    }

    const writeResult = await agentManager.executeAgentTool('contentManager', 'write', {
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

    if (action.type === 'replace') {
      const hasOldContent = typeof action.oldContent === 'string';
      const hasStartLine = typeof action.startLine === 'number';
      const hasEndLine = typeof action.endLine === 'number';
      const hasPosition = typeof action.position === 'number';

      if (hasPosition) {
        if (action.position! < 1) {
          return { valid: false, error: 'position must be a positive line number for replace action' };
        }
        if (hasStartLine || hasEndLine) {
          return { valid: false, error: 'position cannot be combined with startLine or endLine for replace action' };
        }
        if (!hasOldContent) {
          return { valid: false, error: 'oldContent is required when using deprecated position for replace action' };
        }
      }

      if (!hasPosition && (hasOldContent || hasStartLine || hasEndLine)) {
        if (!hasOldContent || !hasStartLine || !hasEndLine) {
          return { valid: false, error: 'replace line-range mode requires oldContent, startLine, and endLine' };
        }
      }

      if (hasStartLine && action.startLine! < 1) {
        return { valid: false, error: 'startLine must be a positive line number for replace action' };
      }

      if (hasEndLine && action.endLine! < 1) {
        return { valid: false, error: 'endLine must be a positive line number for replace action' };
      }

      if (hasStartLine && hasEndLine && action.endLine! < action.startLine!) {
        return { valid: false, error: 'endLine cannot be less than startLine for replace action' };
      }
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
      const agentManager = this.agentManager;
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

      const imageResult = await agentManager.executeAgentTool('promptManager', 'generateImage', imageParams);

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
