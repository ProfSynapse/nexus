import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import { BaseTool } from '../../baseTool';
import { CreatePromptParams, CreatePromptResult } from '../types';
import { CustomPromptStorageService } from '../services/CustomPromptStorageService';

/**
 * Tool for creating a new custom prompt
 */
export class CreatePromptTool extends BaseTool<CreatePromptParams, CreatePromptResult> {
  private storageService: CustomPromptStorageService;

  /**
   * Create a new CreatePromptTool
   * @param storageService Custom prompt storage service
   */
  constructor(storageService: CustomPromptStorageService) {
    super(
      'createPrompt',
      'Create Prompt',
      'Create a new custom prompt',
      '1.0.0'
    );

    this.storageService = storageService;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the created prompt
   */
  async execute(params: CreatePromptParams): Promise<CreatePromptResult> {
    try {
      const { name, description, prompt, isEnabled = true } = params;

      // Validate required fields
      if (!name?.trim()) {
        return this.prepareResult(false, undefined, 'Name is required');
      }

      if (!description?.trim()) {
        return this.prepareResult(false, undefined, 'Description is required');
      }

      if (!prompt?.trim()) {
        return this.prepareResult(false, undefined, 'Prompt text is required');
      }

      // Create the prompt
      await this.storageService.createPrompt({
        name: name.trim(),
        description: description.trim(),
        prompt: prompt.trim(),
        isEnabled
      });

      // Success - LLM already knows what it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, `Failed to create prompt: ${error}`);
    }
  }

  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the prompt (must be unique)',
          minLength: 1,
          maxLength: 100
        },
        description: {
          type: 'string',
          description: 'Description of what this prompt does',
          minLength: 1,
          maxLength: 500
        },
        prompt: {
          type: 'string',
          description: 'The actual prompt text/persona',
          minLength: 1
        },
        isEnabled: {
          type: 'boolean',
          description: 'Whether the prompt is enabled',
          default: true
        }
      },
      required: ['name', 'description', 'prompt']
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean', description: 'Whether the operation succeeded' },
        error: { type: 'string', description: 'Error message if failed (includes recovery guidance)' }
      },
      required: ['success']
    };
  }
}
