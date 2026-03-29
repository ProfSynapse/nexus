/**
 * Location: /src/agents/memoryManager/validators/StateValidator.ts
 *
 * Purpose: Validates state creation and update parameters
 * Extracted from ValidationService.ts to follow Single Responsibility Principle
 *
 * Used by: State-related modes for parameter validation
 * Dependencies: None
 */

import { ValidationError } from './ValidationTypes';

export type StateCreationParams = {
  name?: unknown;
  conversationContext?: unknown;
  activeTask?: unknown;
  activeFiles?: unknown;
  nextSteps?: unknown;
  reasoning?: unknown;
};

/**
 * Validator for state operations
 */
export class StateValidator {
  /**
   * Validate state creation parameters
   */
  static validateCreationParams(params: StateCreationParams): ValidationError[] {
    const errors: ValidationError[] = [];

    if (!params.name) {
      errors.push({
        field: 'name',
        value: params.name,
        requirement: 'State name is required and must be a descriptive, non-empty string'
      });
    }

    if (!params.conversationContext) {
      errors.push({
        field: 'conversationContext',
        value: params.conversationContext,
        requirement: 'Conversation context is required. Provide a summary of what was happening when you decided to save this state'
      });
    }

    if (!params.activeTask) {
      errors.push({
        field: 'activeTask',
        value: params.activeTask,
        requirement: 'Active task description is required. Be specific about the current task you were working on'
      });
    }

    if (!params.activeFiles || !Array.isArray(params.activeFiles) || params.activeFiles.length === 0) {
      errors.push({
        field: 'activeFiles',
        value: params.activeFiles,
        requirement: 'Active files list is required. Specify which files were being edited or referenced'
      });
    }

    if (!params.nextSteps || !Array.isArray(params.nextSteps) || params.nextSteps.length === 0) {
      errors.push({
        field: 'nextSteps',
        value: params.nextSteps,
        requirement: 'Next steps are required. Provide specific actionable steps for when you resume'
      });
    }

    if (!params.reasoning) {
      errors.push({
        field: 'reasoning',
        value: params.reasoning,
        requirement: 'Reasoning for saving state is required. Explain why you are saving the state at this point'
      });
    }

    return errors;
  }
}
