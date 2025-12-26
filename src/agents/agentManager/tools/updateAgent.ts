import { BaseTool } from '../../baseTool';
import { UpdateAgentParams, UpdateAgentResult } from '../types';
import { CustomPromptStorageService } from '../services/CustomPromptStorageService';

/**
 * Tool for updating an existing custom agent
 */
export class UpdateAgentTool extends BaseTool<UpdateAgentParams, UpdateAgentResult> {
  private storageService: CustomPromptStorageService;

  /**
   * Create a new UpdateAgentTool
   * @param storageService Custom prompt storage service
   */
  constructor(storageService: CustomPromptStorageService) {
    super(
      'updateAgent',
      'Update Agent',
      'Update an existing custom agent',
      '1.0.0'
    );
    
    this.storageService = storageService;
  }
  
  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the updated prompt
   */
  async execute(params: UpdateAgentParams): Promise<UpdateAgentResult> {
    try {
      const { id, name, description, prompt, isEnabled } = params;

      // Validate required ID
      if (!id?.trim()) {
        return this.prepareResult(false, undefined, 'ID is required');
      }

      // Check that at least one field is being updated
      if (name === undefined && description === undefined && prompt === undefined && isEnabled === undefined) {
        return this.prepareResult(false, undefined, 'At least one field must be provided for update');
      }

      // Prepare updates object
      const updates: Record<string, unknown> = {};

      if (name !== undefined) {
        if (!name.trim()) {
          return this.prepareResult(false, undefined, 'Name cannot be empty');
        }
        updates.name = name.trim();
      }

      if (description !== undefined) {
        if (!description.trim()) {
          return this.prepareResult(false, undefined, 'Description cannot be empty');
        }
        updates.description = description.trim();
      }

      if (prompt !== undefined) {
        if (!prompt.trim()) {
          return this.prepareResult(false, undefined, 'Prompt text cannot be empty');
        }
        updates.prompt = prompt.trim();
      }

      if (isEnabled !== undefined) {
        updates.isEnabled = isEnabled;
      }

      // Update the prompt
      await this.storageService.updatePrompt(id.trim(), updates);

      // Success - LLM already knows what it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, `Failed to update agent: ${error}`);
    }
  }
  
  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): any {
    const toolSchema = {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Unique ID of the prompt to update',
          minLength: 1
        },
        name: {
          type: 'string',
          description: 'New name for the prompt (must be unique)',
          minLength: 1,
          maxLength: 100
        },
        description: {
          type: 'string',
          description: 'New description for the prompt',
          minLength: 1,
          maxLength: 500
        },
        prompt: {
          type: 'string',
          description: 'New prompt text/persona',
          minLength: 1
        },
        isEnabled: {
          type: 'boolean',
          description: 'Whether the prompt is enabled'
        }
      },
      required: ['id']
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