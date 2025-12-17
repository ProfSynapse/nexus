import { BaseTool } from '../../baseTool';
import { DeleteAgentParams, DeleteAgentResult } from '../types';
import { CustomPromptStorageService } from '../services/CustomPromptStorageService';
import { getCommonResultSchema, createResult } from '../../../utils/schemaUtils';

/**
 * Tool for deleting a custom prompt
 */
export class DeleteAgentTool extends BaseTool<DeleteAgentParams, DeleteAgentResult> {
  private storageService: CustomPromptStorageService;

  /**
   * Create a new DeleteAgentTool
   * @param storageService Custom prompt storage service
   */
  constructor(storageService: CustomPromptStorageService) {
    super(
      'deleteAgent',
      'Delete Agent',
      'Delete a custom agent',
      '1.0.0'
    );
    
    this.storageService = storageService;
  }
  
  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with deletion result
   */
  async execute(params: DeleteAgentParams): Promise<DeleteAgentResult> {
    try {
      const { id } = params;
      
      // Validate required ID
      if (!id?.trim()) {
        return createResult<DeleteAgentResult>(false, null, 'ID is required');
      }
      
      // Check if prompt exists before deletion (unified lookup by ID or name)
      const existingPrompt = this.storageService.getPromptByNameOrId(id.trim());
      if (!existingPrompt) {
        return createResult<DeleteAgentResult>(false, null, `Prompt "${id}" not found (searched by both name and ID)`);
      }

      // Delete the prompt using actual ID
      const deleted = await this.storageService.deletePrompt(existingPrompt.id);
      
      return createResult<DeleteAgentResult>(true, {
        deleted,
        id: id.trim()
      }, undefined);
    } catch (error) {
      return createResult<DeleteAgentResult>(false, null, `Failed to delete prompt: ${error}`);
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
          description: 'ID or name of the agent to delete. Accepts either the unique agent ID or the agent name.',
          minLength: 1
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
            deleted: { type: 'boolean' },
            id: { type: 'string' }
          },
          required: ['deleted', 'id']
        }
      }
    };
  }
}