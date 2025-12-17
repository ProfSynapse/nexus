import { BaseTool } from '../../baseTool';
import { UpdateAgentParams, UpdateAgentResult } from '../types';
import { CustomPromptStorageService } from '../services/CustomPromptStorageService';
import { getCommonResultSchema, createResult } from '../../../utils/schemaUtils';
import { addRecommendations } from '../../../utils/recommendationUtils';
import { NudgeHelpers } from '../../../utils/nudgeHelpers';

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
        return createResult<UpdateAgentResult>(false, null, 'ID is required');
      }
      
      // Check that at least one field is being updated
      if (name === undefined && description === undefined && prompt === undefined && isEnabled === undefined) {
        return createResult<UpdateAgentResult>(false, null, 'At least one field must be provided for update');
      }
      
      // Prepare updates object
      const updates: any = {};
      
      if (name !== undefined) {
        if (!name.trim()) {
          return createResult<UpdateAgentResult>(false, null, 'Name cannot be empty');
        }
        updates.name = name.trim();
      }
      
      if (description !== undefined) {
        if (!description.trim()) {
          return createResult<UpdateAgentResult>(false, null, 'Description cannot be empty');
        }
        updates.description = description.trim();
      }
      
      if (prompt !== undefined) {
        if (!prompt.trim()) {
          return createResult<UpdateAgentResult>(false, null, 'Prompt text cannot be empty');
        }
        updates.prompt = prompt.trim();
      }
      
      if (isEnabled !== undefined) {
        updates.isEnabled = isEnabled;
      }
      
      // Update the prompt
      const updatedPrompt = await this.storageService.updatePrompt(id.trim(), updates);
      
      const result = createResult<UpdateAgentResult>(true, updatedPrompt, undefined);
      return addRecommendations(result, [NudgeHelpers.suggestAgentTesting()]);
    } catch (error) {
      return createResult<UpdateAgentResult>(false, null, `Failed to update prompt: ${error}`);
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

  /**
   * Get the JSON schema for the tool's result
   * @returns JSON schema object
   */
  getResultSchema(): any {
    const commonSchema = getCommonResultSchema();

    // Override the data property to define the specific structure for this tool
    return {
      ...commonSchema,
      properties: {
        ...commonSchema.properties,
        data: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            prompt: { type: 'string' },
            isEnabled: { type: 'boolean' }
          },
          required: ['id', 'name', 'description', 'prompt', 'isEnabled']
        },
        recommendations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              message: { type: 'string' }
            },
            required: ['type', 'message']
          },
          description: 'Workspace-agent optimization recommendations'
        }
      }
    };
  }
}